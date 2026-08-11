import os
from pathlib import Path
import sys

SERVICE_ROOT = Path(__file__).resolve().parents[1]

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

# The rate limiter lives on the app's single module-level instance, shared
# by every test file's `from app.main import app`. Must be set before
# app.main is first imported anywhere in the session, or the whole test
# suite's combined calls to rate-limited paths (route/chat/login) would
# trip it.
os.environ.setdefault("RATE_LIMIT_REQUESTS_PER_MINUTE", "100000")

# Tests must be hermetic and not depend on whatever the real .env currently
# has (e.g. after rotating the admin password for a real deployment) - pin
# the credentials the whole suite logs in with here, overriding .env.
os.environ.setdefault("ADMIN_DEFAULT_USERNAME", "admin")
os.environ.setdefault("ADMIN_DEFAULT_PASSWORD", "change-me")
