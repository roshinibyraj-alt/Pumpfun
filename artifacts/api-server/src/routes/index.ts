import { Router, type IRouter } from "express";
import healthRouter from "./health";
import btcRouter from "./btc";

const router: IRouter = Router();

router.use(healthRouter);
router.use(btcRouter);

export default router;
