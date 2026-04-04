import { MongoClient } from 'mongodb';
import { env } from '../env.js';

let client: MongoClient | null = null;
let connected = false;
let lastError: string | null = null;

function normalizeMongoUri(value: string) {
  const uri = String(value ?? '').trim();
  if (!uri || /^replace-with/i.test(uri)) return '';
  return uri;
}

export function isMongoConfigured() {
  return Boolean(normalizeMongoUri(env.MONGODB_URI));
}

export function mongoState() {
  return { connected, lastError };
}

export async function getMongoClient(): Promise<MongoClient | null> {
  if (!isMongoConfigured()) return null;
  if (client) return client;
  try {
    client = new MongoClient(normalizeMongoUri(env.MONGODB_URI), {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    await client.connect();
    connected = true;
    lastError = null;
    return client;
  } catch (error) {
    client = null;
    connected = false;
    lastError = String(error);
    console.warn('[lcn-backend] MongoDB connection failed, falling back to local JSON storage.', buildMongoHint(lastError));
    return null;
  }
}

function buildMongoHint(message: string) {
  if (/ENOTFOUND|querySrv|DNS|timed out/i.test(message)) {
    return `${message} | Hint: Atlas DNS lookup failed. Check internet access, DNS, VPN/proxy, or try a non-SRV mongodb:// URI.`;
  }
  if (/ECONNRESET|MongoServerSelectionError/i.test(message)) {
    return `${message} | Hint: Network path to Atlas was reset. Check Atlas IP access list, firewall, VPN/proxy, and cluster status.`;
  }
  if (/Authentication failed|bad auth|auth/i.test(message)) {
    return `${message} | Hint: Verify the MongoDB username/password and URL-encoding in MONGODB_URI.`;
  }
  return message;
}

