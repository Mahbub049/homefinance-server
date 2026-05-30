import express from "express";
import cors from "cors";
import morgan from "morgan";

import healthRouter from "./routes/health.route.js";
import authRouter from "./routes/auth.route.js";
import familyRouter from "./routes/family.route.js";
import categoryRouter from "./routes/category.route.js";
import paymentMethodRouter from "./routes/paymentMethod.route.js";
import cardLabelRouter from "./routes/cardLabel.route.js";
import ledgerRouter from "./routes/ledger.route.js";

import accountRouter from "./routes/account.route.js";
import transactionRouter from "./routes/transaction.route.js";

import fixedRouter from "./routes/fixed.route.js";
import groceryRouter from "./routes/grocery.route.js";
import groceryShopRouter from "./routes/groceryShop.route.js";
import emiRouter from "./routes/emi.route.js";
import dashboardRouter from "./routes/dashboard.route.js";
import exportRouter from "./routes/export.route.js";
import savingsRouter from "./routes/savings.route.js";
import networthRouter from "./routes/networth.route.js";
import walletRouter from "./routes/wallet.route.js";
import monthBalanceRouter from "./routes/monthBalance.route.js";
import yearOverviewRouter from "./routes/yearOverview.route.js";
import plannedPurchaseRouter from "./routes/plannedPurchase.route.js";
import individualSummaryRouter from "./routes/individualSummary.route.js";

const app = express();

// middlewares
const allowedOrigins = [
  process.env.CLIENT_URL,

  // Web local development
  "http://localhost:5173",
  "http://localhost:3000",

  // Capacitor Android / WebView origins
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",

  // Add your deployed frontend URL here if not already in CLIENT_URL
  "https://homefinance.vercel.app",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow Postman, server-to-server, mobile/native requests without origin
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked by CORS:", origin);

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(morgan("dev"));

// routes
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/family", familyRouter);
app.use("/api/categories", categoryRouter);
app.use("/api/payment-methods", paymentMethodRouter);
app.use("/api/card-labels", cardLabelRouter);
app.use("/api/accounts", accountRouter);
app.use("/api/ledger", ledgerRouter);
app.use("/api/transactions", transactionRouter);

app.use("/api/fixed", fixedRouter);
app.use("/api/grocery", groceryRouter);
app.use("/api/grocery-shops", groceryShopRouter);
app.use("/api/emi", emiRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/export", exportRouter);
app.use("/api/savings", savingsRouter);
app.use("/api/networth", networthRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/month-balance", monthBalanceRouter);
app.use("/api/year-overview", yearOverviewRouter);
app.use("/api/planned-purchases", plannedPurchaseRouter);
app.use("/api/individual-summary", individualSummaryRouter);

// default route
app.get("/", (req, res) => {
  res.send("HomeFinance Ledger API is running");
});

export default app;