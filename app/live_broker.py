"""Async bridge to the authenticated Polymarket CLOB trader."""
import asyncio
import json
import os
from pathlib import Path
from typing import Optional


class LiveTraderBridge:
    def __init__(self):
        self.process: Optional[asyncio.subprocess.Process] = None
        self.ready = False
        self.address: Optional[str] = None
        self.funder_address: Optional[str] = None
        self.balance: Optional[float] = None
        self._lock = asyncio.Lock()
        self._stderr_task: Optional[asyncio.Task] = None
        self._next_request = 0

    async def start(self):
        script = Path(__file__).resolve().parent.parent / "live_trader_bridge.js"
        env = os.environ.copy()
        self.process = await asyncio.create_subprocess_exec(
            os.getenv("NODE_BINARY", "node"), str(script),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(script.parent),
            env=env,
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout=20)
        if not line:
            raise RuntimeError("live trader bridge exited before authentication")
        message = json.loads(line.decode("utf-8"))
        if message.get("type") != "ready":
            raise RuntimeError(message.get("error") or "live trader authentication failed")
        self.address = message.get("address")
        self.funder_address = message.get("funderAddress")
        self.balance = message.get("balance")
        self.ready = True

    async def _drain_stderr(self):
        if not self.process or not self.process.stderr:
            return
        while True:
            line = await self.process.stderr.readline()
            if not line:
                return
            print(f"live_trader: {line.decode('utf-8', errors='replace').rstrip()}")

    async def request(self, action: str, **payload):
        if not self.ready or not self.process or not self.process.stdin or not self.process.stdout:
            raise RuntimeError("live trader bridge is not ready")
        async with self._lock:
            self._next_request += 1
            request_id = str(self._next_request)
            command = {"action": action, "requestId": request_id, **payload}
            self.process.stdin.write((json.dumps(command) + "\n").encode("utf-8"))
            await self.process.stdin.drain()
            line = await asyncio.wait_for(self.process.stdout.readline(), timeout=15)
            if not line:
                self.ready = False
                raise RuntimeError("live trader bridge disconnected")
            response = json.loads(line.decode("utf-8"))
            if not response.get("ok"):
                raise RuntimeError(response.get("error") or "live CLOB request failed")
            return response.get("result") or {}

    async def place_fok_buy(self, token_id: str, amount: float):
        return await self.request("place_fok_buy", tokenId=token_id, amount=amount)

    async def refresh_balance(self):
        result = await self.request("balance")
        self.balance = result.get("balance")
        return self.balance

    async def close(self):
        self.ready = False
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=3)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self._stderr_task:
            self._stderr_task.cancel()
        self.process = None
