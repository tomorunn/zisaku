const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

async function testConnection() {
  try {
    await client.connect();
    console.log('Connected to MongoDB successfully');
    await client.close();
  } catch (error) {
    console.error('Connection failed:', error);
  }
}

testConnection();