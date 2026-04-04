import { MongoClient } from "mongodb";

export async function createMongoStorage({ uri, dbName = "commit_confessional" } = {}) {
  const normalizedUri = String(uri || "").trim();
  if (!normalizedUri) {
    return createDisabledStorage();
  }

  try {
    const client = new MongoClient(normalizedUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    const db = client.db(dbName);
    const stateCollection = db.collection("app_state");

    return {
      enabled: true,
      async loadArray(key) {
        const doc = await stateCollection.findOne({ _id: key });
        return Array.isArray(doc?.value) ? doc.value : [];
      },
      async loadObject(key) {
        const doc = await stateCollection.findOne({ _id: key });
        return doc && typeof doc.value === "object" ? doc.value : null;
      },
      async persist(key, value) {
        if (value === null || value === undefined) {
          await stateCollection.deleteOne({ _id: key });
          return;
        }

        await stateCollection.updateOne(
          { _id: key },
          {
            $set: {
              value,
              updatedAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
      },
      async close() {
        await client.close();
      },
    };
  } catch (error) {
    console.warn("MongoDB connection failed, falling back to local JSON storage.", buildMongoHint(error));
    return createDisabledStorage();
  }
}

function buildMongoHint(error) {
  const message = String(error?.message || error || "unknown error");
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

function createDisabledStorage() {
  return {
    enabled: false,
    async loadArray() {
      return [];
    },
    async loadObject() {
      return null;
    },
    async persist() {},
    async close() {},
  };
}
