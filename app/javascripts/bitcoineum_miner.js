/*
 * Bitcoineum Miner
 * Copyright 2017, the Bitcoineum Development team
 * Mining interface to Ethereum smart contract
 *
 */

'use strict';

import { default as Web3} from 'web3';
import { default as contract } from 'truffle-contract'
import EthereumBlocks from 'ethereum-blocks'
import BigNumber from 'bignumber.js'

import bitcoineum_artifacts from '../../build/contracts/Bitcoineum.json'

class BitcoineumBlock {

	constructor(miner, 
		        blockTargetDifficultyWei,
		        blockTotalMiningWei,
		        blockCurrentAttemptOffset,
		        blockMiningAttempted) {
		        	
		        	this.miner = miner;
		            this.blockNumber = miner.blockNumber;
		            this.reward = miner.calculateMiningReward();
		            this.payed = false;
		            this.payee = null;
		            this.didWin = false;

		    		if (arguments.length == 1) {
		    			this.targetDifficultyWei = miner.currentDifficultyWei;
		                this.totalMiningWei = 0;
		                this.totaMiningAttempts = 0;
		                this.miningAttempted = false;
		            } else {
		            	this.targetDifficultyWei = blockTargetDifficultyWei;
		            	this.totalMiningWei = blockTotalMiningWei;
		            	this.totaMiningAttempts = blockCurrentAttemptOffset;
		            	this.miningAttempted = blockMiningAttempted;
		            }
	}

}

class BitcoineumMiner {

	constructor(miningAccount) {
		console.log("Initializing Bitcoineum Miner...");
		console.log("Using mining account: " + miningAccount);
		this.bitcoineum_contract = contract(bitcoineum_artifacts);
		this.bitcoineum_contract.setProvider(web3.currentProvider);
		this.mining_account = miningAccount;

		this.tracked_blocks = {};

		this.pending_won_blocks = {};

		this.pending_check_blocks = {};

		this.external_block = null;

		this.currentDifficultyWei = null; 
		this.minimumDifficultyThresholdWei = null; 
		this.blockNumber = null;
		this.blockCreationRate = null;
		this.difficultyAdjustmentPeriod = null; 
		this.rewardAdjustmentPeriod = null;
		this.lastDifficultyAdjustmentEthereumBlock = null; 
		this.totalBlocksMined = null; 
		this.totalWeiCommitted = null; 
		this.totalWeiExpected = null; 

		this.minimumMineAttempt = null;

		// Let's initialize after the node is done syncing
		// and set up callbacks

		this.waitForSync();

		this.syncStatusChange();

	}

	waitForSync() {
		var self = this;
		console.log("Waiting for sync...");
        web3.eth.getSyncing(function(error, sync){
            if(!error) {
                if(sync === true) {
                   web3.reset(true);
                } else if(sync) {
                   console.log("Syncing: " + sync.startingBlock + " => " + sync.currentBlock + " => " + sync.highestBlock);
                   setTimeout(function() {
                   	   self.waitForSync();
				   }, 2500)
                } else {
                	web3.eth.getBlock('latest', function(err, Block) {
                		if (err != null) {
							console.log("There was an error getting the latest block");
							console.log("Try reloading");
							console.log(err);
							return;
						} else {
                			self.initializeState(Block.number);
						}
					});
                }
            } else {
            	 console.log(error);
		    }
        });
	}

	syncStatusChange() {
		var self = this;
		web3.eth.isSyncing(function(Sync) {
			console.log("Syncing state transition...");
		});

	}

	initializeState(currentExternalBlock) {
        var self = this;

        var bte;
        this.bitcoineum_contract.deployed().then(function(instance) {
        bte = instance;
        // Let's query the contract for important initial state variables
        // We will update this state as we get Events from the contract
        // that change the processing state
        return Promise.all([bte.balanceOf.call(self.mining_account,
          	                   	   {from: self.mining_account}),
          	                  bte.getContractState.call()])
        }).then(function([balance,
        	              contractState]) {

		    self.balance = balance;

			// External best block on sync
		    self.external_block = currentExternalBlock;

		    // Break out the contract state into it's respective
		    // Variables
		    // Wei should be left as big numbers
		    self.currentDifficultyWei = contractState[0];
		    self.minimumDifficultyThresholdWei = contractState[1];

		    self.last_processed_blockNumber = contractState[2].toNumber();
		    self.blockCreationRate = contractState[3].toNumber();
		    self.difficultyAdjustmentPeriod = contractState[4].toNumber();
		    self.rewardAdjustmentPeriod = contractState[5].toNumber();
		    self.lastDifficultyAdjustmentEthereumBlock = contractState[6].toNumber();
		    self.totalBlocksMined = contractState[7].toNumber();

		    // These should be left as big numbers
		    self.totalWeiCommitted = contractState[8];
		    self.totalWeiExpected = contractState[9];
		    
		    // Calculate the currently active Bitcoineum block
		    self.blockNumber = self.currentBlock();

		    self.minimumMineAttempt = self.currentDifficultyWei.dividedBy(1000).ceil();

	        self.printStats();
	        // Add the initial block
	        self.addInitialBlock(contractState[10],   // b.targetDifficultyWei
	        					 contractState[11],  // b.totalMiningWei
	        					 contractState[12], // b.currentAttemptOffset
	                             contractState[13]); // Did the user try to mine?

		    // Let's watch for new blocks
		    self.subscribeBlockWatching();

		    // Let's replay mining attempts
		    self.subscribeMiningAttempts(currentExternalBlock);

		    // Let's replay mining claims
		    self.subscribeClaimEvents(currentExternalBlock);

		    // For debugging let's subscribe to log events
		    self.subscribeLogEvents(currentExternalBlock);
		 })
	}

	printStats() {
        var self = this;
		console.log("Miner State");
		console.log("-------------------");
		console.log("Block Number: " + self.blockNumber);
		console.log("Minimum threshold Wei: " + self.minimumDifficultyThresholdWei + " (" + web3.fromWei(self.minimumDifficultyThresholdWei, 'ether') + " ether)");
		console.log("Minimum mining attempt Wei: " + self.minimumMineAttempt + " (" + web3.fromWei(self.minimumMineAttempt, 'ether') + " ether)");
		console.log("Block creation rate: " + self.blockCreationRate);
		console.log("Difficulty adjustment period: " + self.difficultyAdjustmentPeriod);
		console.log("Last Ethereum block adjustment: " + self.lastDifficultyAdjustmentEthereumBlock);
		console.log("Total blocks mined: " + self.totalBlocksMined);
		console.log("Total wei committed for mining period: " + self.totalWeiCommitted + " (" + web3.fromWei(self.totalWeiCommitted, 'ether') + " ether)");
		console.log("Total wei expected for mining period: " + self.totalWeiExpected + " (" + web3.fromWei(self.totalWeiExpected, 'ether') + " ether)");
		console.log("-------------------");
	}


	subscribeBlockWatching() {
		var self = this;
		this.blocks = new EthereumBlocks({ web3: web3 });
        this.blocks.registerHandler('incomingBlockHandler',
        	 (eventType, blockId, data) => {
          switch (eventType) {
            case 'block':
              
              /* data = result of web3.eth.getBlock(blockId) */
              self.external_block = data.number;
              if (self.currentBlock() != self.blockNumber) {
              	  // We just switched block boundaries
              	  self.addNewBlock(data);
			  }
              break;
            case 'error':
              /* data = Error instance */
              console.error(data);
              break;
          }
        });
      this.blocks.start().then((started) => {
      		  console.log (started ? 'Block watch started' : 'Block watch already running');
	  }).catch(console.error);
	}

	subscribeMiningAttempts(currentBlock) {
  	  var self = this;
  	  var bte;
  	  this.bitcoineum_contract.deployed().then(function(instance) {
  	  	  bte = instance;
  	  	  var event = bte.MiningAttemptEvent(currentBlock);
  	  	  console.log("Watching mining attempts from block: " + (currentBlock));
  	  	  event.watch(function(error, response) {
  	  	  	  console.log("Got mining attempt event");
  	  	  	  console.log(response.args._from);
  	  	  	  console.log(response.args._value.toString());
  	  	  	  console.log(response.args._blockNumber.toString());
  	  	  	  console.log(response.args._totalMinedWei.toString());
		  });
	  });
	}

	subscribeClaimEvents(currentBlock) {
  	  var self = this;
  	  var bte;
  	  this.bitcoineum_contract.deployed().then(function(instance) {
  	  	  bte = instance;
  	  	  var event = bte.BlockClaimedEvent({fromBlock: currentBlock});
  	  	  console.log("Watching reward claims from block: " + (currentBlock));
  	  	  event.watch(function(error, response) {
  	  	  	  console.log("Got block claimed event");
  	  	  	  console.log(response.args._from);
  	  	  	  console.log(response.args._reward.toString());
  	  	  	  console.log(response.args._blockNumber.toString());
		  });
	  });
	}

	subscribeLogEvents(currentBlock) {
  	  var self = this;
  	  var bte;
  	  this.bitcoineum_contract.deployed().then(function(instance) {
  	  	  bte = instance;
  	  	  var event = bte.LogEvent({fromBlock: currentBlock});
  	  	  event.watch(function(error, response) {
  	  	  	  console.log("Log " + response.args._info.toString());
		  });
	  });
	}

	addInitialBlock(blockTargetDifficultyWei, blockTotalMiningWei, blockCurrentAttemptOffset) {
		var self = this;
		self.blockNumber = self.currentBlock();
		self.tracked_blocks[self.blockNumber] = 
			new BitcoineumBlock(self,
			                    blockTargetDifficultyWei,
			                    blockTotalMiningWei,
			                    blockCurrentAttemptOffset);
		console.log("Initial Bitcoineum block: " + self.blockNumber + "(" + self.external_block + ")");
	}

	addNewBlock(web3BlockData) {
		var self = this;
		// Create a new block entry
		let previous_blocknum = self.blockNumber;
		self.blockNumber = self.currentBlock();
		// Just because we are creating a new Bitcoineum block doesn't mean that the
		// block exists in the Bitcoineum contract, that won't happen until there is a mining
		// attempt.
		// Here we will create block data based on known state, and upate it as we get events

		// Check if the previous block has been recorded

		var b = self.tracked_blocks[previous_blocknum];
		if (b) {
			// The previous block exists, and is now mature
			if (b.miningAttempted) {
				// I also tried to mine this
				console.log("Block " + previous_blocknum + " [Check] ");
				this.pending_check_blocks[previous_blocknum] = self.tracked_blocks[previous_blocknum];
			} else {
				console.log("Block " + previous_blocknum + " [Closed] ");
			}
			delete self.tracked_blocks[previous_blocknum];
		}

		self.tracked_blocks[self.blockNumber] = new BitcoineumBlock(self);
		console.log("Block " + self.blockNumber + " (" + self.external_block + ")[Open]");
	}

	isBlockMature(Block) {
		return (this.blockNumber > (Block.blockNumber + 1 * this.blockCreationRate));
	}

	currentBlock() {
		return Math.trunc(this.external_block / this.blockCreationRate);
	}

	setMiningAccount(account) {
		return web3.isAddress(account) ? this.mining_account = account && true : false;
	}

	calculateMiningReward() {
		var self = this;
		let mined_block_period = 0;
        if (self.totalBlocksMined < self.rewardAdjustmentPeriod) {
             mined_block_period = self.rewardAdjustmentPeriod;
        } else {
             mined_block_period = self.totalBlocksMined;
        }

        let total_reward = 50;
        for (var i=0; i < (mined_block_period / self.rewardAdjustmentPeriod); i++) {
            total_reward = total_reward / 2;
        }
        return total_reward;
	}

	// Send a mine attempt transaction
	// If there are no arguments use the current minimum difficulty
	mine() {
		var self = this;
		var bte;
		self.bitcoineum_contract.deployed().then(function(instance) {
			bte = instance;
			return bte.mine({from: self.mining_account,
				             gas: 500000,
				             value: self.minimumMineAttempt.times(1000)});
        }).then(function(Res) {
        	      // We won't get a result from the state modifying transaction
        	      // Have to wait for a mining attempt event
        	      console.log("Block " + self.blockNumber + " [Pending]");
        	      self.tracked_blocks[self.blockNumber].miningAttempted = true;
        }).catch(function(e) {
        	console.log("Block " + self.blockNumber + " [Error]");
        	console.log(e);
        });
	}

	// Did we win this block?
	// We ask the network instead of trying
	// to do this locally because block reorganizations
	// could mislead us.
	// If the network says we won, then we can try and claim our prize
	check(block_to_check) {
		var self = this;
		var bte;
		
		self.bitcoineum_contract.deployed().then(function(instance) {
			bte = instance;
			return bte.checkWinning.call(block_to_check,
				                    {from: self.mining_account});
        }).then(function(Result) {
        	if (Result) {
        		console.log("Block " + block_to_check + " [Won!]");
        		if (self.pending_check_blocks[block_to_check]) {
        			 self.pending_check_blocks[block_to_check].didWin = true;
				}
			} else {
				console.log("Block " + block_to_check + " [Lost]");
        		if (self.pending_check_blocks[block_to_check]) {
        			 self.pending_check_blocks[block_to_check].didWin = false;
				}
			}
        }).catch(function(e) {
          console.log(e);
          self.setStatus("Block " + block_to_check + " [Error]");
        });


	}

	// If we won, we should be able to claim the block
	// and redeem the Bitcoineum into our account
	
	claim(block_to_claim) {
		var self = this;
		var bte;
		
		self.bitcoineum_contract.deployed().then(function(instance) {
			bte = instance;
			return bte.claim(block_to_claim,
				             {from: self.mining_account,
				             	 gas: 500000});
        }).then(function(Result) {
        		console.log("Block " + block_to_claim + " [Claimed]");
        }).catch(function(e) {
          console.log(e);
          self.setStatus("Block " + block_to_claim + " [Claim Error]");
        });


	}


}

module.exports = BitcoineumMiner;
