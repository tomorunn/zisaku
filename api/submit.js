const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

module.exports = async (req, res) => {
  try {
    console.log('Connecting to MongoDB with URI:', uri ? 'URI exists' : 'URI missing');
    await client.connect();
    console.log('Connected to MongoDB');
    const database = client.db('contest');
    const collection = database.collection('submissions');

    const submission = {
      data: req.body.data,
      timestamp: new Date()
    };
    console.log('Submission data:', submission);

    const result = await collection.insertOne(submission);
    console.log('Insert result:', result);
    res.status(200).json({ message: 'Submission saved', id: result.insertedId });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await client.close();
  }
};