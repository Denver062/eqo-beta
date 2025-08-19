import { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    try {
      const response = await axios.post(
        'http://localhost:5001/api/tts',
        { text },
        {
          responseType: 'arraybuffer',
        }
      );

      res.setHeader('Content-Type', 'audio/wav');
      res.status(200).send(response.data);
    } catch (error) {
      console.error('Error with Coqui TTS API:', error);
      res.status(500).json({ error: 'Error generating speech' });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
