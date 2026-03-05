import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "API is healthy ✅",
    time: new Date().toISOString(),
  });
});

export default router;