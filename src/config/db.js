import mongoose from "mongoose";

const globalCache = globalThis.__mongooseCache || {
  conn: null,
  promise: null,
};

globalThis.__mongooseCache = globalCache;

export async function connectDB(uri) {
  if (!uri) {
    throw new Error("MONGO_URI missing");
  }

  if (globalCache.conn) {
    return globalCache.conn;
  }

  mongoose.set("strictQuery", true);

  if (!globalCache.promise) {
    globalCache.promise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 10000,
      })
      .then((mongooseInstance) => {
        console.log("MongoDB connected");
        return mongooseInstance;
      });
  }

  globalCache.conn = await globalCache.promise;
  return globalCache.conn;
}