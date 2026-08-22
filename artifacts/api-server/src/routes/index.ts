import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { predictionsRouter } from "./predictions";

const router: IRouter = Router();

router.use(healthRouter);
// MLB keeps the historical root paths; NPB serves its own store under /npb.
router.use(predictionsRouter("mlb"));
router.use("/npb", predictionsRouter("npb"));

export default router;
