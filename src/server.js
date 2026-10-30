import dotenv from "dotenv";
import app from "./app.js";
import { connectDB } from "./config/db.js";
import {runSavingsAuto} from "./utils/runSavingsAuto.js";

dotenv.config();

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB(process.env.MONGO_URI);
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
    });
    // Optional for a permanently running Express server. For serverless,
    // configure a daily scheduler to call the secured /api/savings/auto/run.
    if (process.env.ENABLE_SAVINGS_AUTO === 'true') {
      const tick = () => runSavingsAuto().then(r => {
        if (r.recorded || r.errors.length) console.log('Savings auto:', JSON.stringify(r));
      }).catch(e => console.error('Savings auto error:', e.message));
      tick();
      setInterval(tick, 60 * 60 * 1000).unref();
    }
  } catch (e) {
    console.error("❌ Server failed:", e.message);
    process.exit(1);
  }
}

start();