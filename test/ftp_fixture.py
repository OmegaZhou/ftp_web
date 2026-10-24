"""Isolated protocol test server. Its test credentials never leave loopback."""
import pathlib
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

root = pathlib.Path(sys.argv[1])
authorizer = DummyAuthorizer()
for username in ('alice', 'bob'):
    folder = root / username
    folder.mkdir(parents=True, exist_ok=True)
    authorizer.add_user(username, 'integration-only', str(folder), perm='elradfmwMT')
FTPHandler.authorizer = authorizer
FTPHandler.auth_failed_timeout = 0.05
server = FTPServer(('127.0.0.1', 0), FTPHandler)
print(server.socket.getsockname()[1], flush=True)
server.serve_forever()
