import { Router, type IRouter } from "express";
import healthRouter from "./health";
import predictionsRouter from "./predictions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(predictionsRouter);

export default router;
