"""Run the local regression suite: python tests/run_all.py."""
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
ok = True
for name in ("test_engine.py", "test_state.py"):
    print(f"\n=== {name}")
    ok &= subprocess.call([sys.executable, os.path.join(here, name)]) == 0
print("\nALL TESTS PASSED" if ok else "\nFAILURES")
sys.exit(0 if ok else 1)