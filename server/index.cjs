const express = require('express');
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const cors = require('cors');

// Try to load .env if available
try {
  require('dotenv').config();
} catch (e) {
  // ignore
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const bedrockClient = new BedrockRuntimeClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.VITE_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.VITE_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
  }
});

app.post("/call-bedrock", async (req, res) => {
  try {
    const { modelId, messages } = req.body;
    
    // We need to convert base64 strings back to Uint8Array for the SDK
    const parsedMessages = messages.map(msg => {
      if (msg.content) {
        msg.content = msg.content.map(block => {
          if (block.document && block.document.source && block.document.source.bytesBase64) {
            const buf = Buffer.from(block.document.source.bytesBase64, 'base64');
            block.document.source.bytes = new Uint8Array(buf);
            delete block.document.source.bytesBase64;
          }
          if (block.image && block.image.source && block.image.source.bytesBase64) {
            const buf = Buffer.from(block.image.source.bytesBase64, 'base64');
            block.image.source.bytes = new Uint8Array(buf);
            delete block.image.source.bytesBase64;
          }
          return block;
        });
      }
      return msg;
    });

    const command = new ConverseCommand({
      modelId: modelId || "amazon.nova-lite-v1:0",
      messages: parsedMessages
    });
    
    const response = await bedrockClient.send(command);
    res.json(response);
  } catch (err) {
    console.error("Bedrock Call Failed:", err);
    res.status(500).json({ error: err.message || "Unknown proxy error" });
  }
});

const PORT = 5111;
app.listen(PORT, () => console.log(`Bedrock Proxy Server running on port ${PORT}`));
