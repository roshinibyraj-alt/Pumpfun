import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tennisRouter from "./tennis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tennisRouter);

export default router;
