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

	constructor(miningAccount, logFun) {
		var self = this;
		logFun ? this.logger = logFun : this.logger = console.log;
		self.logger("Initializing Bitcoineum Miner...");
		self.logger("Using mining account: " + miningAccount);
		this.bitcoineum_contract = contract(bitcoineum_artifacts);
		this.bitcoineum_contract.setProvider(web3.currentProvider);
		this.mining_account = miningAccount;
		this.credit_account = miningAccount;
		this.debug = false;
		self.logger("Credit mining rewards to: " + this.credit_account);
		this.auto_mine = false;

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

		// Max total spend across all minining attempts
		// 0.5 Ether limit unless specifically modified
		// Caps max loss

		this.maximumSpend = web3.toWei(0.5, 'ether');
		this.spend = web3.toWei(0, 'ether');

		// Bet limiter
		// If the bet is exceeded we cap the bet, and turn disable auto mine
		this.maxAttemptValue = web3.toWei('100', 'finney');

		// This is the percentage of the total difficulty we are going to bet
		// By default bet the entire difficulty
		this.attemptPercentage = 1;

		// Let's initialize after the node is done syncing
		// and set up callbacks

		this.waitForSync();

		this.syncStatusChange();

	}

	set_mining_account(miningAccount) {
		if (web3.isAddress(miningAccount)) {
			this.mining_account = miningAccount;
			this.logger("New mining account: " + this.mining_account);
		} else {
			this.logger("Invalid Ethereum account.");
		}
	}

	set_credit_account(creditAccount) {
		if (web3.isAddress(creditAccount)) {
			this.credit_account = creditAccount;
			this.logger("New credit to account: " + this.credit_account);
		} else {
			this.logger("Invalid Ethereum account.");
		}
	}

	set_max_spend_value(value) {
		this.maximumSpend = value;
	}

	set_max_attempt_value(value) {
		// Probably should do some validation on this number
		this.maxAttemptValue = value;
	}

	set_attempt_percentage(value) {
		if (value > 0 && value < 1) {
			this.attemptPercentage = value;
			this.logger("Percentage set to: " + value + "(" + value*100 + "%)");
		} else {
			this.logger("Percentage must be expressed between 0 and 1");
		}
	}

	autoMine() { 
		var self = this;
		let x = this.calculateAttemptValue();
		this.auto_mine = !this.auto_mine 
		if (this.auto_mine) {
			// Reset the max spend counter
			self.spend = 0;
			self.logger("Auto mining enabled");
			self.logger("Attempt value: " + web3.fromWei(x, 'ether') + ' ether');
			self.logger("Max attempt: " + web3.fromWei(this.maxAttemptValue, 'ether') + ' ether');
			self.logger("Attempt %: " + (this.attemptPercentage * 100) + "%");
		} else {
			self.logger("Auto mining disabled");
		}
	}

	toggleDebug() {
		this.debug = !this.debug;
		if (this.debug) {
			this.logger("debugging enabled")
		} else {
			this.logger("debugging disabled");
		}
	}

	waitForSync() {
		var self = this;
		self.logger("Waiting for sync...");
        web3.eth.getSyncing(function(error, sync){
            if(!error) {
                if(sync === true) {
                   web3.reset(true);
                } else if(sync) {
                   self.logger("Syncing: " + sync.startingBlock + " => " + sync.currentBlock + " => " + sync.highestBlock);
                   setTimeout(function() {
                   	   self.waitForSync();
				   }, 2500)
                } else {
                	web3.eth.getBlock('latest', function(err, Block) {
                		if (err != null) {
							self.logger("There was an error getting the latest block");
							self.logger("Try reloading");
							self.logger(err);
							return;
						} else {
                			self.initializeState(Block.number);
						}
					});
                }
            } else {
            	 self.logger(error);
		    }
        });
	}

	syncStatusChange() {
		var self = this;
		web3.eth.isSyncing(function(Sync) {
			self.logger("Syncing state transition...");
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

		    self.minimumMineAttempt = self.currentDifficultyWei.dividedBy(1000000).ceil();

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
		    // self.subscribeLogEvents(currentExternalBlock);
		 })
	}

	printStats() {
        var self = this;
		self.logger("Miner State");
		self.logger("-------------------");
		self.logger("Block Number: " + self.blockNumber);
		self.logger("Minimum threshold Wei: " + self.minimumDifficultyThresholdWei + " (" + web3.fromWei(self.minimumDifficultyThresholdWei, 'ether') + " ether)");
		self.logger("Minimum mining attempt Wei: " + self.minimumMineAttempt + " (" + web3.fromWei(self.minimumMineAttempt, 'ether') + " ether)");
		self.logger("Block creation rate: " + self.blockCreationRate);
		self.logger("Difficulty adjustment period: " + self.difficultyAdjustmentPeriod);
		self.logger("Last Ethereum block adjustment: " + self.lastDifficultyAdjustmentEthereumBlock);
		self.logger("Total blocks mined: " + self.totalBlocksMined);
		self.logger("Total wei committed for mining period: " + self.totalWeiCommitted + " (" + web3.fromWei(self.totalWeiCommitted, 'ether') + " ether)");
		self.logger("Total wei expected for mining period: " + self.totalWeiExpected + " (" + web3.fromWei(self.totalWeiExpected, 'ether') + " ether)");
		self.logger("-------------------");
	}

	printConfig() {
		var self = this;
		self.logger("Miner configuration parameters");
		self.logger("------------------------------");
		self.logger("Mining Account: " + self.mining_account);
		self.logger("For credit to: " + self.credit_account);
		self.logger("Maximum attempt value: " + self.maxAttemptValue + " (" + web3.fromWei(self.maxAttemptValue, 'ether') + " ether)");
		self.logger("Maximum attempt percentage: " + self.attemptPercentage * 100 + "%");
		self.logger("------------------------------");
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
      		  self.logger (started ? 'Block watch started' : 'Block watch already running');
	  }).catch(console.error);
	}

	subscribeMiningAttempts(currentBlock) {
  	  var self = this;
  	  var bte;
  	  this.bitcoineum_contract.deployed().then(function(instance) {
  	  	  bte = instance;
  	  	  var event = bte.MiningAttemptEvent({fromBlock: currentBlock});
  	  	  self.logger("Watching mining attempts from block: " + (currentBlock));
  	  	  event.watch(function(error, response) {
  	  	  	  // This could easily be extended to emit events via registered functions
  	  	  	  // to create an extended interface
  	  	  	  if (self.debug) {
  	  	  	  	  self.logger("Mine attempt: [" +  response.args._blockNumber.toString() + "][" + response.args._from + "][" + response.args._value.toString() + "][" + response.args._totalMinedWei.toString() + "]");
			  }
		  });
	  });
	}

	subscribeClaimEvents(currentBlock) {
  	  var self = this;
  	  var bte;
  	  this.bitcoineum_contract.deployed().then(function(instance) {
  	  	  bte = instance;
  	  	  var event = bte.BlockClaimedEvent({fromBlock: currentBlock});
  	  	  self.logger("Debug: Watching reward claims from block: " + (currentBlock));
  	  	  event.watch(function(error, response) {
  	  	  	  if (self.debug) {
  	  	  	  	  self.logger("Block Claimed: [" +  response.args._blockNumber.toString() + "][" + response.args._from + "][" + response.args._forCreditTo + "][" + response.args._reward.toString() + "]");
			  }
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
  	  	  	  self.logger("Log " + response.args._info.toString());
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
		self.logger("Initial Bitcoineum block: " + self.blockNumber + "(" + self.external_block + ")");
	}

	addNewBlock(web3BlockData) {
		var self = this;
		// Create a new block entry
		let previous_blocknum = self.blockNumber - 1;
		self.blockNumber = self.currentBlock();
		// Just because we are creating a new Bitcoineum block doesn't mean that the
		// block exists in the Bitcoineum contract, that won't happen until there is a mining
		// attempt.
		// Here we will create block data based on known state, and upate it as we get events

		// Check if two blocks previous has been recorded
		// And if we want to try and claim a reward

		var b = self.tracked_blocks[previous_blocknum];
		if (b) {
			// The previous block exists, and is now mature
			if (b.miningAttempted) {
				// I also tried to mine this
				self.check(previous_blocknum, function(Result) {
					if (Result) {
						if (self.auto_mine) {
						    self.claim(previous_blocknum);
						}
					} else {
						self.logger ("Block window " + previous_blocknum + " [Missed]");
					}
				});
			} else {
				self.logger("Block window " + previous_blocknum + " [Closed] ");
			}
			delete self.tracked_blocks[previous_blocknum];
		}

		self.tracked_blocks[self.blockNumber] = new BitcoineumBlock(self);
		self.logger("Block window " + self.blockNumber + " (" + self.external_block + ")[Open]");
		// If we are auto mining, then kick off a mine attempt for this block
		// given the miner parameters
		if (self.auto_mine) {
			self.mine();
		}
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

        let total_reward = 50 * (10**8);
        for (var i=1; i < (mined_block_period / self.rewardAdjustmentPeriod); i++) {
            total_reward = total_reward / 2;
        }
        return total_reward;
	}

	calculateAttemptValue() {
		var self = this;
		let x = self.currentDifficultyWei.times(self.attemptPercentage);
		if (x.greaterThan(self.maxAttemptValue)) {
			self.logger("Max difficulty exceeded bet, pausing auto mine.");
			self.auto_mine = false;
			x = self.maxAttemptValue;
		}
		return x;
	}

	// Send a mine attempt transaction
	// If there are no arguments use the current minimum difficulty
	mine() {
		var self = this;
		var bte;
		self.bitcoineum_contract.deployed().then(function(instance) {
			bte = instance;
			var attemptValue = self.calculateAttemptValue();
			self.spend += attemptValue;
			if (self.spend >= self.maximumSpend) {
				// We have exceeded the max spend
				// We may have pending redeems 
				self.logger("Maximum spend exceeded, halting auto mine");
				self.auto_mine = false;
				return;
			}
			return bte.mine({from: self.mining_account,
				             gas: 400000, //270000
				             value: self.calculateAttemptValue() });
        }).then(function(Res) {
        	      // We won't get a result from the state modifying transaction
        	      // Have to wait for a mining attempt event
        	      self.logger("Block window " + self.blockNumber + " [Pending]");
        	      self.tracked_blocks[self.blockNumber].miningAttempted = true;
        }).catch(function(e) {
        	self.logger("Block window " + self.blockNumber + " [Error]");
        	self.logger(e);
        });
	}

	// Did we win this block?
	// We ask the network instead of trying
	// to do this locally because block reorganizations
	// could mislead us.
	// If the network says we won, then we can try and claim our prize
	check(block_to_check, callbackFun) {
		self.logger("Block window " + block_to_check + " [Check] ");
		var self = this;
		var bte;
		
		self.bitcoineum_contract.deployed().then(function(instance) {
			bte = instance;
			return bte.checkWinning.call(block_to_check,
				                    {from: self.mining_account});
        }).then(function(Result) {
        	if (callbackFun) {
        		callbackFun(Result);
			} else {
				// Default fun
        	    if (Result) {
        	    	self.logger("Block window " + block_to_check + " [Won!]");
			    } else {
			    	self.logger("Block window " + block_to_check + " [Lost]");
			    }
			}
        }).catch(function(e) {
          self.logger(e);
          self.setStatus("Block window " + block_to_check + " [Error]");
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
				             self.credit_account, // forCreditTo
				             {from: self.mining_account,
				             	 gas: 400000});
        }).then(function(Result) {
        		self.logger("Block window " + block_to_claim + " [Claimed]");
        }).catch(function(e) {
          self.logger(e);
          self.setStatus("Block window " + block_to_claim + " [Claim Error]");
        });


	}


}

module.exports = BitcoineumMiner;
