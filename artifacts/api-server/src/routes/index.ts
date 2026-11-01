import { Router, type IRouter } from "express";
import healthRouter from "./health";
import btcRouter from "./btc";
import strategyRouter from "./strategy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(btcRouter);
router.use(strategyRouter);

export default router;
