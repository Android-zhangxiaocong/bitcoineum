pragma solidity ^0.4.11;

import 'zeppelin-solidity/contracts/token/StandardToken.sol';
import 'zeppelin-solidity/contracts/ReentrancyGuard.sol';
import 'zeppelin-solidity/contracts/SafeMath.sol';


/**
 * @title ERC20Mineable
 * @dev Coin creation through mining as a game of chance
 * @dev Mimics the Bitcoin coin creation process
 * @dev Whitepaper: http://www.bitcoineum.com/assets/Bitcoineum.pdf
 */

contract ERC20Mineable is StandardToken, ReentrancyGuard  {
   
   /** totalSupply in StandardToken refers to currently available supply
   * maximumSupply refers to the cap on mining.
   * When mining is finished totalSupply == maximumSupply
   */
   uint public maximumSupply;

   // Current mining difficulty in Wei
   uint public currentDifficultyWei;

   // Minimum difficulty
   uint public minimumDifficultyThresholdWei;

   // Current Internal Block counter
   uint public blockNumber;

   // Block creation rate as number of Ethereum blocks per mining cycle
   // 10 minutes at 17 seconds a block would be an internal block
   // generated every 35 Ethereum blocks
   uint public blockCreationRate;

   // difficultyAdjustmentPeriod should be every two weeks, or
   // 2016 blocks.
   uint public difficultyAdjustmentPeriod;

   // When was the last time we did a difficulty adjustment.
   uint public lastDifficultyAdjustmentEthereumBlock;

   // Total blocks mined helps us calculate the current reward
   uint public totalBlocksMined;

   // Reward adjustment period in Bitcoineum native blocks

   uint rewardAdjustmentPeriod; 

   // Total amount of Wei put into mining during current period
   uint public totalWeiCommitted;
   // Total amount of Wei expected for this mining period
   uint public totalWeiExpected;

   // The block when the contract goes active
   // So we can calculate the internal block correctly
   uint genesisBlock;

   // Where to burn Ether
   address burnAddress;

   /** Each block is created on a mining attempt if
   * it does not already exist.
   * this keeps track of the target difficulty at the time of creation
   */

   struct InternalBlock {
      uint targetDifficultyWei;
      uint blockNumber;
      uint totalMiningWei;
      uint totalMiningAttempts;
      uint currentAttemptOffset;
      bool payed;
      address payee;
      bool isCreated;
   }

   /** Mining attempts are given a projected offset to minimize
   * keyspace overlap to increase fairness by reducing the redemption
   * race condition
   * This does not remove the possibility that two or more miners will
   * be competing for the same award, especially if subsequent increases in
   * wei from a single miner increase overlap
   */
   struct MiningAttempt {
      uint projectedOffset;
      uint value;
      bool isCreated;
   }

   // Each guess gets assigned to a block
   mapping (uint => InternalBlock) public blockData;
   mapping (uint => mapping (address => MiningAttempt)) public miningAttempts;

   // Utility related

   function external_to_internal_block_number(uint _externalBlockNum) public constant returns (uint) {
      // blockCreationRate is > 0
      return _externalBlockNum / blockCreationRate;
   }

   // Initial state related
   /** Dapps need to grab the initial state of the contract
   * in order to properly initialize mining or tracking
   * this is a single atomic function for getting state
   * rather than scattering it across multiple public calls
   * also returns the current blocks parameters
   * or default params if it hasn't been created yet
   * This is only called externally
   */

   function getContractState() external constant
     returns (uint,  // currentDifficultyWei
              uint,  // minimumDifficultyThresholdWei
              uint,  // blockNumber
              uint,  // blockCreationRate
              uint,  // difficultyAdjustmentPeriod
              uint,  // rewardAdjustmentPeriod
              uint,  // lastDifficultyAdustmentEthereumBlock
              uint,  // totalBlocksMined
              uint,  // totalWeiCommitted
              uint,  // totalWeiExpected
              uint,  // b.targetDifficultyWei
              uint,  // b.totalMiningWei
              uint,  // b.currentAttemptOffset
              bool   // msg.sender attempted to mine
              ) {
    InternalBlock memory b;
    bool mining_attempted = false;
    if (!blockData[blockNumber].isCreated) {
        b = InternalBlock(
                       {targetDifficultyWei: currentDifficultyWei,
                       blockNumber: blockNumber,
                       totalMiningWei: 0,
                       totalMiningAttempts: 0,
                       currentAttemptOffset: 0,
                       payed: false,
                       payee: 0,
                       isCreated: true
                       });
    } else {
         b = blockData[blockNumber];
         if (miningAttempts[blockNumber][msg.sender].isCreated) {
             mining_attempted = true;
         }
    }
    return (currentDifficultyWei,
            minimumDifficultyThresholdWei,
            blockNumber,
            blockCreationRate,
            difficultyAdjustmentPeriod,
            rewardAdjustmentPeriod,
            lastDifficultyAdjustmentEthereumBlock,
            totalBlocksMined,
            totalWeiCommitted,
            totalWeiExpected,
            b.targetDifficultyWei,
            b.totalMiningWei,
            b.currentAttemptOffset,
            mining_attempted);
   }

   // Mining Related

   modifier blockCreated(uint _blockNum) {
     if (!blockData[_blockNum].isCreated) {
       throw;
     }
     _;
   }

   modifier blockRedeemed(uint _blockNum) {
     require(_blockNum != block.number);
     // Should capture if the blockdata is payed
     // or if it does not exist in the blockData mapping

     if (!blockData[_blockNum].isCreated) {
        throw;
     }

     if (blockData[_blockNum].payed) {
        throw;
     }
     _;
   }

   modifier initBlock(uint _blockNum) {
     require(_blockNum != block.number);

     if (!blockData[_blockNum].isCreated) {
       // Create new block for tracking
       blockData[_blockNum] = InternalBlock(
                                     {targetDifficultyWei: currentDifficultyWei,
                                      blockNumber: _blockNum,
                                      totalMiningWei: 0,
                                      totalMiningAttempts: 0,
                                      currentAttemptOffset: 0,
                                      payed: false,
                                      payee: 0,
                                      isCreated: true
                                      });
     }
     _;
   }

   modifier isValidAttempt() {
     // If the Ether for this mining attempt is less than minimum
     // 0.001 % of total difficulty
     uint minimum_wei = currentDifficultyWei / 1000000; 
     if (msg.value < minimum_wei) {
        throw;
     }

     // Let's bound the value to guard against potential overflow
     // i.e max int, or an underflow bug
     // This is a single attempt
     if (msg.value > (1000000 ether)) {
        throw;
     }

     _;
   }

   modifier alreadyMined(uint blockNumber, address sender) {
     require(blockNumber != block.number); 
    // We are only going to allow one mining attempt per block per account
    // This prevents stuffing and make it easier for us to track boundaries
    if (miningAttempts[blockNumber][sender].isCreated) {
       // This user already made a mining attempt for this block
       throw;
    }
    _;
   }

   modifier isMiningActive() {
      if (totalSupply >= maximumSupply) {
         // Mining is over
         throw;
      }
      _;
   }

   function burn(uint value) internal {
      // We don't really care if the burn fails for some
      // weird reason.
      bool ret = burnAddress.send(value);
      // If we cannot burn this ether, than the contract might
      // be under some kind of stack attack.
      // Even though it shouldn't matter, let's err on the side of
      // caution and throw in case there is some invalid state.
      if (!ret) {
          throw;
      }
   }

   event MiningAttemptEvent(
       address indexed _from,
       uint _value,
       uint indexed _blockNumber,
       uint _totalMinedWei,
       uint _targetDifficultyWei
   );

   event LogEvent(
       string _info
   );

   /**
   * @dev Add a mining attempt for the current internal block
   * Initialize an empty block if not created
   * Invalidate this mining attempt if the block has been paid out
   */

   function mine() external payable 
                           onlyPayloadSize(0) // Extra precaution
                           nonReentrant
                           isValidAttempt
                           isMiningActive
                           initBlock(external_to_internal_block_number(block.number))
                           blockRedeemed(external_to_internal_block_number(block.number))
                           alreadyMined(external_to_internal_block_number(block.number),
                           msg.sender) returns (bool) {
      // Let's immediately adjust the difficulty
      // In case an abnormal period of time has elapsed
      // nobody has been mining etc.
      // Will let us recover the network even if the
      // difficulty spikes to some absurd amount
      adjust_difficulty();
      uint internalBlockNum = external_to_internal_block_number(block.number);

      miningAttempts[internalBlockNum][msg.sender] =
                     MiningAttempt({projectedOffset: blockData[internalBlockNum].currentAttemptOffset,
                                    value: msg.value,
                                    isCreated: true});

      // Increment the mining attempts for this block
      blockData[internalBlockNum].totalMiningAttempts += 1;
      blockData[internalBlockNum].totalMiningWei += msg.value;
      totalWeiCommitted += msg.value;

      // We are trying to stack mining attempts into their relative
      // positions in the key space.
      blockData[internalBlockNum].currentAttemptOffset += msg.value;
      MiningAttemptEvent(msg.sender,
                         msg.value,
                         internalBlockNum,
                         blockData[internalBlockNum].totalMiningWei,
                         blockData[internalBlockNum].targetDifficultyWei
                         );
      // All mining attempt Ether is burned
      burn(msg.value);
      return true;
   }

   // Redemption Related

   modifier userMineAttempted(uint _blockNum, address _user) {
      if (!miningAttempts[_blockNum][_user].isCreated) {
         throw;
      }
      _;
   }
   
   modifier isBlockMature(uint _blockNumber) {
      require(_blockNumber != block.number);

      if (!checkBlockMature(_blockNumber)) {
         throw;
      }

      if (!checkRedemptionWindow(_blockNumber)) {
         throw;
      }
      _;
   }

   // Just in case this block falls outside of the available
   // block range, possibly because of a change in network params
   modifier isBlockReadable(uint _blockNumber) {
      InternalBlock iBlock = blockData[_blockNumber];
      uint targetBlockNum = targetBlockNumber(_blockNumber);
      if (block.blockhash(targetBlockNum) == 0) {
         throw;
      }
      _;
   }

   function calculate_difficulty_attempt(InternalBlock b,
                                         uint value) internal constant returns (uint256) {
      // The total amount of Wei sent for this mining attempt exceeds the difficulty level
      // So the calculation of percentage keyspace should be done on the total wei.
      uint selectedDifficultyWei = 0;
      if (b.totalMiningWei > b.targetDifficultyWei) {
         selectedDifficultyWei = b.totalMiningWei;
      } else {
         selectedDifficultyWei = b.targetDifficultyWei; 
      }

      // normalize the value against the entire key space
      // Multiply it out because we do not have floating point
      // 1000000 is .000001 % increments

      uint256 intermediate = ((value * 1000000) / selectedDifficultyWei);
      uint256 max_int = 0;
      // Underflow to maxint
      max_int = max_int - 1;

      if (intermediate >= 1000000) {
         return max_int;
      } else {
         return intermediate * (max_int / 1000000);
      }
   }

   function calculate_range_attempt(uint difficulty, uint offset) internal constant returns (uint, uint) {
       // Both the difficulty and offset should be normalized
       // against the difficulty scale.
       // If they are not we might have an integer overflow
       if (offset + difficulty <  offset) {
          throw;
        }

        return (offset, offset+difficulty);
   }

   function calculate_mining_reward() internal constant returns (uint) {
      // Block rewards starts at 50 Bitcoineum
      // Every 10 minutes
      // Block reward decreases by 50% every 210000 blocks
      uint mined_block_period = 0;
      if (totalBlocksMined < 210000) {
           mined_block_period = 210000;
      } else {
           mined_block_period = totalBlocksMined;
      }

      // Again we have to do this iteratively because of floating
      // point limitations in solidity.
      uint total_reward = 50 * (10 ** 8); // 8 Decimals
      for (uint i=1; i < (mined_block_period / 210000); i++) {
          total_reward = total_reward / 2;
      }
      return total_reward;

   }

   function adjust_difficulty() internal {
      // Total blocks mined might not be increasing if the 
      // difficulty is too high. So we should instead base the adjustment
      // on the progression of the Ethereum network.

      if ((block.number - lastDifficultyAdjustmentEthereumBlock) > (difficultyAdjustmentPeriod * blockCreationRate)) {
          // The adjustment window has been fulfilled
          // The new difficulty should be bounded by the total wei actually spent
          // capped at 4 times

          uint lowerBound = totalWeiExpected / 4;
          uint upperBound = totalWeiExpected * 4;

          if (totalWeiCommitted < lowerBound) {
              totalWeiExpected = lowerBound;
          }

          if (totalWeiCommitted > upperBound) {
              totalWeiExpected = upperBound;
          }

          // If difficulty drops too low lets set it to our minimum.
          // This may halt coin creation, but obviously does not affect
          // token transactions.
          if (totalWeiExpected < minimumDifficultyThresholdWei) {
              totalWeiExpected = minimumDifficultyThresholdWei;
          }

          // Regardless of difficulty adjustment, let us totalWeiCommited
          totalWeiCommitted = 0;

           // Lets reset the difficulty adjustment block target
           lastDifficultyAdjustmentEthereumBlock = block.number;

      }
   }

   event BlockClaimedEvent(
       address indexed _from,
       address indexed _forCreditTo,
       uint _reward,
       uint indexed _blockNumber
   );

   modifier onlyWinner(uint _blockNumber) {
      if (!checkWinning(_blockNumber)) {
         throw;
         }
      _;
   }

   /** 
   * @dev Claim the mining reward for a given block
   * @param _blockNumber The internal block that the user is trying to claim
   * @param forCreditTo When the miner account is different from the account
   * where we want to deliver the redeemed Bitcoineum. I.e Hard wallet.
   */
   function claim(uint _blockNumber, address forCreditTo)
                  onlyPayloadSize(2 * 32)  //extra precaution
                  nonReentrant
                  blockRedeemed(_blockNumber)
                  isBlockMature(_blockNumber)
                  isBlockReadable(_blockNumber)
                  userMineAttempted(_blockNumber, msg.sender)
                  onlyWinner(_blockNumber)
                  external returns (bool) {
      // If attempt is valid, invalidate redemption
      // Difficulty is adjusted here
      // and on bidding, in case bidding stalls out for some
      // unusual period of time.
      // Do everything, then adjust supply and balance
      blockData[_blockNumber].payed = true;
      blockData[_blockNumber].payee = msg.sender;
      totalBlocksMined = totalBlocksMined + 1;
      adjust_difficulty();

      uint reward = calculate_mining_reward();

      balances[forCreditTo] = balances[forCreditTo].add(reward);
      
      totalSupply += reward;
      BlockClaimedEvent(msg.sender, forCreditTo,
                        reward,
                        _blockNumber);
      // Mining rewards should show up as ERC20 transfer events
      // So that ERC20 scanners will see token creation.
      Transfer(this, forCreditTo, reward);
      return true;
   }

   /** 
   * @dev Claim the mining reward for a given block
   * @param _blockNum The internal block that the user is trying to claim
   */
   function isBlockRedeemed(uint _blockNum) constant public returns (bool) {
     if (!blockData[_blockNum].isCreated) {
         return false;
     } else {
         return blockData[_blockNum].payed;
     }
   }

   /** 
   * @dev Get the target block in the winning equation 
   * @param _blockNum is the internal block number to get the target block for
   */
   function targetBlockNumber(uint _blockNum) constant public returns (uint) {
      return ((_blockNum + 1) * blockCreationRate);
   }

   /** 
   * @dev Check whether a given block is mature 
   * @param _blockNum is the internal block number to check 
   */
   function checkBlockMature(uint _blockNum) constant public returns (bool) {
     return (block.number > targetBlockNumber(_blockNum));
   }

   /**
   * @dev Check the redemption window for a given block
   * @param _blockNum is the internal block number to check
   */

   function checkRedemptionWindow(uint _blockNum) constant public returns (bool) {
     return block.number <= (targetBlockNumber(_blockNum) + 256);
   }

   /** 
   * @dev Check whether a mining attempt was made by sender for this block
   * @param _blockNum is the internal block number to check
   */
   function checkMiningAttempt(uint _blockNum) constant public returns (bool) {
       return miningAttempts[_blockNum][msg.sender].isCreated;
   }

   /** 
   * @dev Did the user win a specific block and can claim it?
   * @param _blockNum is the internal block number to check
   */
   function checkWinning(uint _blockNum) constant public returns (bool) {
     if (checkMiningAttempt(_blockNum) && checkBlockMature(_blockNum)) {

      InternalBlock iBlock = blockData[_blockNum];
      uint targetBlockNum = targetBlockNumber(iBlock.blockNumber);
      MiningAttempt attempt = miningAttempts[_blockNum][msg.sender];

      uint difficultyAttempt = calculate_difficulty_attempt(iBlock, attempt.value);
      uint beginRange;
      uint endRange;
      uint256 targetBlockHashInt;

      (beginRange, endRange) = calculate_range_attempt(difficultyAttempt,
          calculate_difficulty_attempt(iBlock, attempt.projectedOffset)); 
      targetBlockHashInt = uint256(sha256(block.blockhash(targetBlockNum)));
      
      if ((beginRange < targetBlockHashInt) && (endRange >= targetBlockHashInt))
      {
        return true;
      }
     
     }

     return false;
     
   }

}

