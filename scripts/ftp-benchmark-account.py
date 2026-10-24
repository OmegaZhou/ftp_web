#!/usr/bin/env python3
"""Root-only, bounded temporary vsftpd account lifecycle for release benchmarks.

Replaces ad-hoc database dump/edit commands. Never emits passwords or DB records.
No service restart or global FTP/PAM edits are performed. Stop benchmark clients,
run `app-cleanup` for each app data directory, then run account `cleanup`.
"""

import argparse
import fcntl
import ftplib
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

DB = Path('/etc/vsftpd/vusers.db')
CONFIGS = Path('/etc/vsftpd/user_config')
STATE = Path('/var/lib/ftp-web-benchmark')
ROOT_PARENT = Path('/home/vsftpd')
PREFIX = 'ftpweb_bench_'
USERNAME = re.compile(r'ftpweb_bench_[0-9]{8}_[a-f0-9]{16}\Z')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    fsync_dir(path.parent)


def save_state(path, data):
    temp = path.with_name('credentials.next.json')
    require(not temp.exists(), 'Interrupted state update exists; inspect privately')
    private_write(temp, (json.dumps(data, indent=2) + '\n').encode())
    os.replace(temp, path)
    fsync_dir(path.parent)


def service_pids():
    result = {}
    for name in ('vsftpd', 'ftp-web'):
        value = subprocess.check_output(
            ['systemctl', 'show', name, '--property=MainPID', '--value'], text=True).strip()
        require(value.isdigit() and value != '0', 'Expected service is not running')
        result[name] = int(value)
    return result


def check_database():
    info = DB.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600, 'Unexpected account DB metadata')
    require(CONFIGS.is_dir() and not CONFIGS.is_symlink(), 'Unexpected per-user config directory')


def dump_database(path):
    result = subprocess.run(['/usr/bin/db5.3_dump', str(path)], capture_output=True)
    require(result.returncode == 0, 'Database dump failed (output withheld)')
    lines = result.stdout.splitlines()
    boundary = lines.index(b'HEADER=END')
    header = lines[:boundary + 1]
    require(b'format=bytevalue' in header, 'Unexpected Berkeley DB dump format')
    require(lines[-1] == b'DATA=END', 'Incomplete database dump')
    body = lines[boundary + 1:-1]
    require(len(body) % 2 == 0, 'Invalid database record count')
    records = {}
    for index in range(0, len(body), 2):
        key, value = (bytes.fromhex(body[index + offset].strip().decode('ascii'))
                      for offset in (0, 1))
        require(key not in records, 'Duplicate database key; refusing rewrite')
        records[key] = value
    return header, records


def read_database():
    check_database()
    before = digest(DB.read_bytes())
    header, records = dump_database(DB)
    require(digest(DB.read_bytes()) == before, 'Account DB changed during read; retry')
    return before, header, records


def replace_database(before, header, records):
    # Keep binary dump in memory; no password-containing plaintext dump on disk.
    content = b'\n'.join(header) + b'\n'
    for key, value in records.items():
        content += b' ' + key.hex().encode() + b'\n ' + value.hex().encode() + b'\n'
    content += b'DATA=END\n'
    fd, name = tempfile.mkstemp(prefix='.ftpweb-bench-db-', dir=DB.parent)
    os.close(fd)
    candidate = Path(name)
    try:
        result = subprocess.run(['/usr/bin/db5.3_load', str(candidate)],
                                input=content, capture_output=True)
        require(result.returncode == 0, 'Database build failed (output withheld)')
        os.chown(candidate, 0, 0)
        os.chmod(candidate, 0o600)
        require(dump_database(candidate)[1] == records, 'Rebuilt DB differs from intended records')
        with candidate.open('rb') as source:
            os.fsync(source.fileno())
        # flock serializes this tool; hash guard detects unrelated admin edits.
        require(digest(DB.read_bytes()) == before, 'Account DB changed; no replacement performed')
        os.replace(candidate, DB)
        fsync_dir(DB.parent)
        require(dump_database(DB)[1] == records, 'Post-replacement DB verification failed')
    finally:
        candidate.unlink(missing_ok=True)


def config_bytes(account):
    return (f"# temporary FTP Web benchmark: {account['username']}\n"
            f"local_root={account['root']}\n"
            'write_enable=YES\nvirtual_use_local_privs=YES\n'
            'local_umask=077\n').encode()


def load_account(path):
    path = Path(path)
    require(path.name == 'credentials.json' and path.parent.parent == STATE,
            'Credential path must be inside the dedicated state directory')
    require(not STATE.is_symlink() and not path.parent.is_symlink() and not path.is_symlink(),
            'Credential path may not use symlinks')
    info = path.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
            'Credentials must be root-owned mode 600')
    data = json.loads(path.read_text())
    name = data['username']
    require(USERNAME.fullmatch(name) is not None and path.parent.name == name,
            'Unexpected temporary username')
    require(data['root'] == str(ROOT_PARENT / ('.' + name)), 'Unexpected test root')
    require(data['ftpHost'] == '127.0.0.1' and data['ftpPort'] == 21, 'Unexpected FTP endpoint')
    return path, data


def create():
    before, header, records = read_database()
    pids = service_pids()
    name = PREFIX + time.strftime('%Y%m%d') + '_' + secrets.token_hex(8)
    require(name.encode() not in records, 'Generated account already exists')
    STATE.mkdir(mode=0o700, exist_ok=True)
    info = STATE.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o700, 'Unexpected benchmark state directory')
    state_dir = STATE / name
    state_dir.mkdir(mode=0o700)
    credentials = state_dir / 'credentials.json'
    root = ROOT_PARENT / ('.' + name)
    require(not root.exists() and not root.is_symlink(), 'Test root already exists')
    account = dict(username=name, password=secrets.token_urlsafe(48), root=str(root),
                   ftpHost='127.0.0.1', ftpPort=21, stage='PREPARED',
                   originalRecordCount=len(records), originalDatabaseSha256=before,
                   servicePids=pids)
    private_write(credentials, (json.dumps(account, indent=2) + '\n').encode())
    private_write(state_dir / 'original.db', DB.read_bytes())
    require(digest((state_dir / 'original.db').read_bytes()) == before, 'DB changed during backup')
    guest = pwd.getpwnam('vsftpd')
    root.mkdir(mode=0o700)
    os.chown(root, guest.pw_uid, guest.pw_gid)
    private_write(CONFIGS / name, config_bytes(account))
    expected = dict(records)
    expected[name.encode()] = account['password'].encode()
    replace_database(before, header, expected)
    account['stage'] = 'ACTIVE'
    save_state(credentials, account)
    require(service_pids() == pids, 'Service PID changed unexpectedly; account retained for inspection')
    print(json.dumps(dict(credentials=str(credentials), username=name, root=str(root),
                          originalRecordsUnchanged=True, addedRecords=1,
                          servicePidsUnchanged=True)))


def verify(path):
    credentials, account = load_account(path)
    before_pids = service_pids()
    records = read_database()[2]
    require(records.get(account['username'].encode()) == account['password'].encode(),
            'Temporary account does not match DB')
    require((CONFIGS / account['username']).read_bytes() == config_bytes(account),
            'Per-user config changed')
    root = Path(account['root'])
    require(root.is_dir() and not root.is_symlink(), 'Test root missing or symlinked')
    # A random marker is created on disk first. RETR verifies the chroot *before* writes.
    token = secrets.token_hex(12)
    marker = root / ('.root-proof-' + token)
    payload = secrets.token_bytes(65536)
    private_write(marker, payload)
    guest = pwd.getpwnam('vsftpd')
    os.chown(marker, guest.pw_uid, guest.pw_gid)
    folder = '.io-proof-' + token
    ftp = ftplib.FTP()
    try:
        ftp.connect('127.0.0.1', 21, timeout=20)
        ftp.login(account['username'], account['password'])
        require(ftp.pwd() == '/', 'Temporary account did not enter its chroot')
        actual = io.BytesIO()
        ftp.retrbinary('RETR ' + marker.name, actual.write)
        require(actual.getvalue() == payload, 'Temporary FTP root does not match dedicated root')
        ftp.mkd(folder)
        ftp.storbinary('STOR ' + folder + '/payload.bin', io.BytesIO(payload))
        ftp.rename(folder + '/payload.bin', folder + '/renamed.bin')
        returned = io.BytesIO()
        ftp.retrbinary('RETR ' + folder + '/renamed.bin', returned.write)
        require(digest(returned.getvalue()) == digest(payload), 'FTP round-trip hash mismatch')
        require((root / folder / 'renamed.bin').read_bytes() == payload, 'FTP wrote outside expected root')
        ftp.delete(folder + '/renamed.bin')
        ftp.rmd(folder)
        ftp.quit()
    finally:
        ftp.close()
        marker.unlink(missing_ok=True)
    require(service_pids() == before_pids, 'Service PID changed unexpectedly')
    print(json.dumps(dict(username=account['username'], login=True, chrootVerified=True,
                          mkdirUploadRenameDownloadDelete=True, bytes=len(payload),
                          sha256=digest(payload), servicePidsUnchanged=True)))


def app_cleanup(path, directory, api_base, origin, offline):
    """Revoke through the live app first; remove only this test owner's records."""
    credentials, account = load_account(path)
    directory = Path(directory)
    require(str(directory) in ('/var/lib/ftp-web', '/var/lib/ftp-web-benchmark-app')
            and directory.resolve() == directory, 'Unexpected application data directory')
    database = directory / 'tasks.sqlite'
    require(database.is_file() and not database.is_symlink(), 'Application DB missing or symlinked')
    owner = digest(json.dumps(['127.0.0.1', 21, '/', account['username']], separators=(',', ':')).encode())
    terminal = {'COMPLETED', 'CANCELLED', 'SKIPPED', 'EXPIRED'}
    if offline:
        require(str(directory) == '/var/lib/ftp-web-benchmark-app', 'Offline purge is limited to the isolated candidate')
        with sqlite3.connect(database) as connection:
            for (pid,) in connection.execute('SELECT pid FROM runtime_lock'):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    continue
                raise RuntimeError('Isolated application still has a live runtime owner')
    else:
        require(api_base in ('http://127.0.0.1:9090', 'http://127.0.0.1:19090'), 'Cleanup API must be loopback')
        require(origin in ('https://playerzhou.com', 'http://127.0.0.1:14195'), 'Unexpected application Origin')
        require((directory.name == 'ftp-web') == api_base.endswith(':9090'), 'API port and data directory mismatch')
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        csrf = ''

        def request(endpoint, body=None):
            headers = {'Origin': origin, 'Connection': 'close', 'X-CSRF-Token': csrf}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            req = urllib.request.Request(api_base + '/ftp/api/v2' + endpoint,
                                         data=None if body is None else json.dumps(body).encode(), headers=headers)
            try:
                with opener.open(req, timeout=30) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                raise RuntimeError(f'Application cleanup request failed with HTTP {error.code}') from None

        login = request('/login', {'username': account['username'], 'password': account['password']})
        csrf = login['csrfToken']
        try:
            require(login.get('user', {}).get('id') == owner, 'Authenticated owner differs from expected temporary owner')
            deadline, stable = time.monotonic() + 120, 0
            while time.monotonic() < deadline:
                cursor, tasks = None, []
                while True:
                    result = request('/tasks?limit=500' + ('' if cursor is None else '&cursor=' + urllib.parse.quote(cursor)))
                    tasks.extend(result['tasks'])
                    cursor = result['nextCursor']
                    if cursor is None:
                        break
                for task in tasks:
                    if task['state'] not in terminal and 'cancel' in task['actions']:
                        request('/tasks/' + task['id'] + '/cancel', {})
                if all(task['state'] in terminal and not task.get('cleanupPending') for task in tasks):
                    stable += 1
                    if stable >= 2:
                        break
                else:
                    stable = 0
                time.sleep(1)
            else:
                raise RuntimeError('Temporary tasks did not settle; account and files retained')
        finally:
            request('/logout', {})  # Also revoke in-memory FTP authorization before deleting accounts.

    connection = sqlite3.connect(database, timeout=30)
    try:
        connection.execute('BEGIN IMMEDIATE')
        task_rows = connection.execute('SELECT id,owner,state,destination,data FROM tasks ORDER BY id').fetchall()
        require(all(row[2] == json.loads(row[4])['state'] for row in task_rows if row[1] == owner),
                'Owner task column and JSON state differ')
        tasks = [json.loads(row[4]) for row in task_rows if row[1] == owner]
        require(all(task['owner'] == owner and task['state'] in terminal and not task.get('cleanupPending')
                    for task in tasks), 'Owner still has active or uncleaned tasks; no purge performed')
        upload_ids = {task['uploadId'] for task in tasks if task.get('uploadId')}
        require(all(re.fullmatch(r'[a-f0-9-]{36}', value) for value in upload_ids), 'Unexpected upload ID')
        require(all(json.loads(row[4]).get('uploadId') not in upload_ids for row in task_rows if row[1] != owner),
                'Upload ID is shared with another owner; refusing purge')

        def other_records():
            return {
                'tasks': connection.execute('SELECT * FROM tasks WHERE owner<>? ORDER BY id', (owner,)).fetchall(),
                'batches': connection.execute('SELECT * FROM batches WHERE owner<>? ORDER BY id', (owner,)).fetchall(),
                'sessions': connection.execute("SELECT * FROM sessions WHERE coalesce(json_extract(data,'$.user.id'),'')<>? ORDER BY id", (owner,)).fetchall(),
                'tus_metadata': [row for row in connection.execute('SELECT * FROM tus_metadata ORDER BY id') if row[0] not in upload_ids],
                'runtime_lock': connection.execute('SELECT * FROM runtime_lock').fetchall(),
            }

        others = other_records()
        staging = directory / 'uploads'
        require(staging.resolve() == staging and staging.is_dir(), 'Unexpected staging directory')
        for upload_id in upload_ids:
            target = staging / upload_id
            require(not target.is_symlink(), 'Staging target is symlinked; refusing purge')
            if target.exists():
                require(target.is_file(), 'Unexpected staging entry')
                target.unlink()
            connection.execute('DELETE FROM tus_metadata WHERE id=?', (upload_id,))
        fsync_dir(staging)
        removed = {
            'tasks': connection.execute('DELETE FROM tasks WHERE owner=?', (owner,)).rowcount,
            'batches': connection.execute('DELETE FROM batches WHERE owner=?', (owner,)).rowcount,
            'sessions': connection.execute("DELETE FROM sessions WHERE json_extract(data,'$.user.id')=?", (owner,)).rowcount,
            'uploadIds': len(upload_ids),
        }
        require(other_records() == others, 'Other owner records changed inside purge transaction')
        connection.commit()
    finally:
        connection.close()
    account.setdefault('appCleanup', {})[str(directory)] = {'at': time.time(), 'removed': removed}
    save_state(credentials, account)
    print(json.dumps(dict(owner=owner, applicationDirectory=str(directory), removed=removed,
                          otherRecordsUnchanged=True, authorizationRevoked=not offline,
                          isolatedStopped=offline)))


def cleanup(path):
    credentials, account = load_account(path)
    owner = digest(json.dumps(['127.0.0.1', 21, '/', account['username']], separators=(',', ':')).encode())
    for directory in ('/var/lib/ftp-web', '/var/lib/ftp-web-benchmark-app'):
        database = Path(directory) / 'tasks.sqlite'
        if database.exists():
            require(directory in account.get('appCleanup', {}), 'Run app-cleanup before account cleanup')
            require(Path(directory).resolve() == Path(directory) and not database.is_symlink(), 'Unexpected application DB path')
            with sqlite3.connect(database) as connection:
                remaining = sum(connection.execute(sql, (owner,)).fetchone()[0] for sql in (
                    'SELECT count(*) FROM tasks WHERE owner=?',
                    'SELECT count(*) FROM batches WHERE owner=?',
                    "SELECT count(*) FROM sessions WHERE json_extract(data,'$.user.id')=?",
                ))
                require(remaining == 0, 'Temporary application records reappeared; repeat app-cleanup')
    before_pids = service_pids()
    before, header, records = read_database()
    name = account['username']
    config = CONFIGS / name
    root = Path(account['root'])
    require(not config.is_symlink() and (not config.exists() or config.read_bytes() == config_bytes(account)),
            'Per-user config differs; refusing cleanup')
    require(not root.is_symlink() and root.parent == ROOT_PARENT
            and root.name == '.' + name, 'Unsafe test root')
    key = name.encode()
    if key in records:
        require(records[key] == account['password'].encode(), 'Account was changed externally; refusing removal')
        expected = dict(records)
        del expected[key]
        replace_database(before, header, expected)
    account['stage'] = 'ACCOUNT_REMOVED'
    save_state(credentials, account)
    config.unlink(missing_ok=True)
    fsync_dir(CONFIGS)
    # shutil.rmtree is symlink-attack resistant on this supported Linux/Python host.
    require(shutil.rmtree.avoids_symlink_attacks, 'Platform lacks safe recursive deletion')
    if root.exists():
        require(root.resolve() == root, 'Test root canonical path changed')
        shutil.rmtree(root)
        fsync_dir(ROOT_PARENT)
    require(service_pids() == before_pids, 'Service PID changed unexpectedly; state retained')
    # Only our known state files may be removed; never restore the original DB snapshot.
    require(set(p.name for p in credentials.parent.iterdir()) <= {'credentials.json', 'original.db'},
            'Unexpected state files; inspect before deleting private state')
    (credentials.parent / 'original.db').unlink(missing_ok=True)
    credentials.unlink()
    credentials.parent.rmdir()
    fsync_dir(STATE)
    print(json.dumps(dict(username=name, accountRemoved=True, otherRecordsUnchanged=True,
                          testRootRemoved=True, privateStateRemoved=True,
                          applicationCleanup='separate prerequisite', servicePidsUnchanged=True)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'verify', 'app-cleanup', 'cleanup'])
    parser.add_argument('credentials', nargs='?')
    parser.add_argument('--app-directory')
    parser.add_argument('--api-base')
    parser.add_argument('--origin')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run as root')
    os.umask(0o077)
    require((args.action == 'create') == (args.credentials is None), 'Credentials path required for verify/cleanup only')
    fd = os.open('/run/lock/ftp-web-benchmark-account.lock',
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.action == 'create':
            create()
        elif args.action == 'verify':
            verify(args.credentials)
        elif args.action == 'app-cleanup':
            require(args.app_directory is not None, 'Application directory is required')
            app_cleanup(args.credentials, args.app_directory, args.api_base, args.origin, args.offline)
        else:
            cleanup(args.credentials)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only our own fixed messages are safe; libraries may include sensitive replies.
        message = str(error) if type(error) is RuntimeError else type(error).__name__
        print('ERROR: ' + message, file=sys.stderr)
        sys.exit(1)
