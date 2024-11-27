require('dotenv').config();
// Required dependencies - using core Apollo Client
const { ApolloClient, InMemoryCache, gql } = require('@apollo/client/core');
const { HttpLink } = require('@apollo/client/link/http');
const fetch = require('cross-fetch');
const Web3 = require('web3');
const ABI = require('./GovernanceToken.json'); // Add your contract ABI here
const mongoose = require('mongoose');

// Configuration
const config = {
    wsProvider: `wss://optimism-mainnet.infura.io/ws/v3/${process.env.RPC_PROVIDER_KEY}`,
    subgraphUrl: 'https://api.studio.thegraph.com/query/68573/op/v0.0.9',
    contractAddress: '0x4200000000000000000000000000000000000042',
    contractABI:ABI, // Add your contract ABI here
    pageSize: 1000,  // SubGraph query limit per request
    totalDelegates: 5000 // Total delegates to track
  };
  

// Initialize Apollo Client for Node.js
const client = new ApolloClient({
  link: new HttpLink({ 
    uri: config.subgraphUrl,
    fetch 
  }),
  cache: new InMemoryCache(),
  defaultOptions: {
    query: {
      fetchPolicy: 'no-cache'
    }
  }
});
// MongoDB Schema
const delegateSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  delegate_id: { type: String, required: true },
  voting_power: {
    vp: { type: Number, required: true },
    th_vp: { type: Number, required: true }
  }
}, {
  timestamps: true,
  // Create a compound index on delegate_id and date for efficient queries
  indexes: [
    { delegate_id: 1, date: 1 }
  ]
});
  
  const Delegate = mongoose.model('Delegate', delegateSchema);
  
  // MongoDB connection function
  async function connectToMongoDB() {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('Connected to MongoDB');
    } catch (error) {
      console.error('MongoDB connection error:', error);
      throw error;
    }
  }  

// Initialize Web3
const web3 = new Web3(new Web3.providers.WebsocketProvider(config.wsProvider));

// Store for delegates
class DelegateStore {
  constructor() {
    this.delegates = new Map();
    this.totalVotingPower = 0;
  }

  // Update voting power for a specific delegate
  updateVotingPower(address, newVotingPower) {
    if (this.delegates.has(address)) {
      this.delegates.get(address).votingPower = newVotingPower;
      this.updatePercentages();
      this.saveSnapshot();
    }
  }

  // Recalculate percentages for all delegates
  updatePercentages() {
    this.totalVotingPower = Array.from(this.delegates.values())
      .reduce((sum, delegate) => sum + delegate.votingPower, 0);

    for (const delegate of this.delegates.values()) {
      delegate.th_vp = (delegate.votingPower / this.totalVotingPower) * 100;
    }
  }

  // Get delegates sorted by voting power
  getTopDelegates(limit = config.totalDelegates) {
    return Array.from(this.delegates.entries())
      .sort((a, b) => b[1].votingPower - a[1].votingPower)
      .slice(0, limit)
      .map(([address, data]) => ({
        address,
        votingPower: data.votingPower,
        th_vp: data.th_vp.toFixed(2)
      }));
  }
}

// Query for getting single delegate data
const DELEGATE_QUERY = gql`
  query GetDelegateData($delegateId: String!) {
    delegate(id: $delegateId) {
      id
      latestBalance
    }
  }
`;

// Function to fetch delegate data from The Graph
async function fetchDelegateFromGraph(address) {
    try {
      const { data } = await client.query({
        query: DELEGATE_QUERY,
        variables: { delegateId: address.toLowerCase() }
      });
      return data?.delegate;
    } catch (error) {
      console.error(`Error fetching delegate data from Graph for ${address}:`, error);
      return null;
    }
  }

// Function to handle voting power updates
async function handleVotingPowerUpdate(address) {
  try {
    const { data } = await client.query({
      query: DELEGATE_QUERY,
      variables: { delegateId: address }
    });

    if (data && data.delegate) {
      const newVotingPower = parseFloat(data.delegate.votingPower);
      delegateStore.updateVotingPower(address, newVotingPower);
      
      // Log update
      console.log(`Updated voting power for ${address}: ${newVotingPower}`);
    }
  } catch (error) {
    console.error('Error updating voting power:', error);
  }
}

// Initialize store
const delegateStore = new DelegateStore();



// Function to update percentages for all delegates
async function updateAllPercentages() {
  try {
    // Calculate total voting power
    const totalVotingPower = await Delegate.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: "$voting_power.vp" }
        }
      }
    ]);

    const total = totalVotingPower[0]?.total || 0;

    // Update all delegates with new percentages
    const delegates = await Delegate.find({});
    
    const bulkOps = delegates.map(delegate => ({
      updateOne: {
        filter: { delegate_id: delegate.delegate_id },
        update: {
          $set: {
            'voting_power.th_vp': (delegate.voting_power.vp / total) * 100
          }
        }
      }
    }));

    if (bulkOps.length > 0) {
      await Delegate.bulkWrite(bulkOps);
    }

  } catch (error) {
    console.error('Error updating percentages:', error);
  }
}

  
async function handleDelegateChanged(event) {
  try {
    const delegator = event.returnValues.delegator;
    const fromDelegate = event.returnValues.fromDelegate;
    const toDelegate = event.returnValues.toDelegate;

    console.log('\nDelegate Change Event Detected:');
    console.log('--------------------------------');
    console.log(`Transaction Hash: ${event.transactionHash}`);
    console.log(`Block Number: ${event.blockNumber}`);
    console.log(`Delegator: ${delegator}`);
    console.log(`From Delegate: ${fromDelegate}`);
    console.log(`To Delegate: ${toDelegate}`);

    const [fromDelegateData, toDelegateData] = await Promise.all([
      fetchDelegateFromGraph(fromDelegate),
      fetchDelegateFromGraph(toDelegate)
    ]);

    console.log('Delegates fetched from The Graph');
    console.log(fromDelegateData, toDelegateData);

    // Update or create delegates in MongoDB with new schema
    if (fromDelegateData) {
      await Delegate.findOneAndUpdate(
        { delegate_id: fromDelegate },
        {
          voting_power: {
            vp: parseFloat(fromDelegateData.latestBalance/10**18),
            th_vp: 0 // This will be updated by updateAllPercentages
          }
        },
        { upsert: true }
      );
    }

    if (toDelegateData) {
      await Delegate.findOneAndUpdate(
        { delegate_id: toDelegate },
        {
          voting_power: {
            vp: parseFloat(toDelegateData.latestBalance/10**18),
            th_vp: 0 // This will be updated by updateAllPercentages
          }
        },
        { upsert: true }
      );
    }

    console.log('Delegates updated in MongoDB');
    
    // Update percentages for all delegates
    await updateAllPercentages();

    // Log updated delegate information
    const [updatedFromDelegate, updatedToDelegate] = await Promise.all([
      Delegate.findOne({ delegate_id: fromDelegate }),
      Delegate.findOne({ delegate_id: toDelegate })
    ]);

    // Log detailed information
    console.log('\nDetailed Delegate Information:');
    console.log('-----------------------------');
    if (updatedFromDelegate) {
      console.log(`\nFrom Delegate (${fromDelegate}):`);
      console.log(`- Voting Power: ${updatedFromDelegate.voting_power.vp}`);
      console.log(`- Percentage: ${updatedFromDelegate.voting_power.th_vp.toFixed(5)}%`);
    }

    if (updatedToDelegate) {
      console.log(`\nTo Delegate (${toDelegate}):`);
      console.log(`- Voting Power: ${updatedToDelegate.voting_power.vp}`);
      console.log(`- Percentage: ${updatedToDelegate.voting_power.th_vp.toFixed(5)}%`);
    }

  } catch (error) {
    console.error('Error handling delegate changed event:', error);
  }
}
// Main function to start monitoring
async function startMonitoring() {
  try {
    console.log('Starting monitoring system...');
    
    // Load initial delegate data with pagination
    // await delegateStore.loadAllDelegates();
    await connectToMongoDB();

    // Set up contract event listener
    const contract = new web3.eth.Contract(config.contractABI, config.contractAddress);
    
    console.log('Setting up event listeners...');
    
    contract.events.DelegateChanged({}, (error, event) => {
        if (error) {
          console.error('Event subscription error:', error);
          return;
        }
        handleDelegateChanged(event);
      });

    console.log('Monitoring system is running...');
    
    // Optional: Periodic full refresh to catch any missed updates
    setInterval(async () => {
      console.log('Performing periodic full refresh...');
    //   await delegateStore.loadAllDelegates();
    }, 1800000); // Refresh every 30 minutes

  } catch (error) {
    console.error('Error in monitoring system:', error);
    process.exit(1);
  }
}

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// Start the monitoring
console.log('Initializing system...');
startMonitoring().catch(console.error);