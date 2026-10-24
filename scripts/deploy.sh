#!/usr/bin/env bash
# Root-only, single-host release management. prepare never changes the running service.
# prepare COMMIT ARCHIVE SHA256 | activate COMMIT CHUNK_BYTES PUBLIC_ORIGIN [BENCHMARK_ID] | rollback BACKUP_DIR
set -Eeuo pipefail
umask 077
BASE=/opt/ftp-web
DATA=/var/lib/ftp-web
BACKUPS=/var/backups/ftp-web
DROPIN=/etc/systemd/system/ftp-web.service.d/20-release.conf
RELEASE_ENV=/etc/ftp-web/release.env
SERVICE=ftp-web

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die 'Run as root on the deployment host.'
for command in python3 sha256sum systemctl curl runuser npm node flock realpath; do command -v "$command" >/dev/null || die "Missing command: $command"; done
exec 9>/run/lock/ftp-web-deploy.lock
flock -n 9 || die 'Another deployment is running.'
validate_commit() { [[ $1 =~ ^[a-f0-9]{40}$ ]] || die 'Use the full Git commit SHA.'; }
release_path() { validate_commit "$1"; printf '%s/releases/%s' "$BASE" "$1"; }

health() {
  local mode=$1 attempt
  for attempt in {1..20}; do
    if systemctl is-active --quiet "$SERVICE"; then
      if [[ $mode == new ]]; then
        if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:9090/ftp/api/v2/session 2>/dev/null |
          python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["authenticated"] is False and isinstance(x["config"]["chunkSize"],int)' 2>/dev/null &&
          curl --fail --silent --show-error --max-time 3 http://127.0.0.1:9090/ftp/app/ >/dev/null 2>&1; then return 0; fi
      elif curl --fail --silent --show-error --max-time 3 http://127.0.0.1:9090/ftp/login.html >/dev/null 2>&1; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

prepare() {
  local commit=$1 archive=$2 expected=$3 release staging
  release=$(release_path "$commit")
  [[ $expected =~ ^[a-f0-9]{64}$ ]] || die 'Invalid archive SHA-256.'
  [[ -f $archive && ! -L $archive ]] || die 'Archive must be a regular file.'
  [[ $(sha256sum "$archive" | cut -d' ' -f1) == "$expected" ]] || die 'Archive digest mismatch.'
  [[ ! -e $release ]] || die 'Release already exists; use its existing immutable contents.'
  install -d -o root -g root -m 0755 "$BASE" "$BASE/releases"
  install -d -o ftpweb -g ftpweb -m 0750 "$DATA"
  install -d -o ftpweb -g ftpweb -m 0750 /var/cache/ftp-web/npm
  staging=$(mktemp -d "$BASE/releases/.prepare-$commit-XXXXXXXX")
  # Reject traversal, symlinks, special files and non-runtime payload before extracting.
  python3 - "$archive" "$staging" "$commit" "$expected" <<'PY'
import json, pathlib, sys, tarfile
archive, target, commit, archive_sha256 = sys.argv[1:]
allowed_files = {'index.js','package.json','package-lock.json','login.html','index.html','LICENSE','README.md','RELEASE.json'}
allowed_trees = ('server/', 'lib/', 'js/', 'img/', 'web/dist/')
with tarfile.open(archive) as bundle:
    members = bundle.getmembers()
    for member in members:
        name = member.name.rstrip('/')
        parts = pathlib.PurePosixPath(name).parts
        if not parts or name.startswith('/') or '..' in parts or '\\' in name or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe archive member')
        if member.isfile() and name not in allowed_files and not name.startswith(allowed_trees):
            raise SystemExit('Unexpected runtime payload: ' + name)
        if name.endswith('.rsa') or '/node_modules/' in name or name.startswith('.data/'):
            raise SystemExit('Secret or runtime data in release')
    bundle.extractall(target, members=members, filter='data')
metadata_path = pathlib.Path(target) / 'RELEASE.json'
if metadata_path.exists() and json.loads(metadata_path.read_text()).get('commit') != commit:
    raise SystemExit('Commit metadata mismatch')
metadata_path.write_text(json.dumps({'commit': commit, 'archiveSha256': archive_sha256}, indent=2) + '\n')
for required in ('index.js','package-lock.json','server/app.ts','web/dist/index.html'):
    if not (pathlib.Path(target) / required).is_file():
        raise SystemExit('Missing runtime file: ' + required)
PY
  # Install under the service identity without lifecycle scripts, then make code immutable to it.
  chown -R ftpweb:ftpweb "$staging"
  runuser -u ftpweb -- env npm_config_cache=/var/cache/ftp-web/npm npm ci --prefix "$staging" --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  runuser -u ftpweb -- /usr/local/bin/node --input-type=module -e "await import('file://$staging/server/app.ts')"
  chown -R root:root "$staging"
  chmod -R u=rwX,go=rX "$staging"
  mv -- "$staging" "$release"
  printf 'Prepared immutable release: %s\nRunning service unchanged.\n' "$release"
}

restore_backup() {
  local backup=$1 current mode=old
  [[ $backup == "$BACKUPS/"* && -d $backup && ! -L $backup && -f $backup/READY && $(realpath "$backup") == "$backup" ]] || die 'Invalid deployment backup.'
  systemctl stop "$SERVICE"
  if [[ -f $backup/drop-in.conf ]]; then install -D -m 0644 "$backup/drop-in.conf" "$DROPIN"; mode=new; else rm -f -- "$DROPIN"; fi
  if [[ -f $backup/release.env ]]; then install -m 0600 "$backup/release.env" "$RELEASE_ENV"; else rm -f -- "$RELEASE_ENV"; fi
  if [[ -s $backup/current ]]; then
    current=$(cat "$backup/current")
    [[ $current == "$BASE/releases/"* && -d $current ]] || die 'Backup points outside release directory.'
    ln -s -- "$current" "$BASE/.current-rollback-$$"
    mv -Tf -- "$BASE/.current-rollback-$$" "$BASE/current"
  else rm -f -- "$BASE/current"; fi
  systemctl daemon-reload
  systemctl start "$SERVICE"
  health "$mode" || die 'Rollback service health failed; inspect journal locally.'
  printf 'Restored previous service configuration. Persistent data was retained.\n'
}

activate() {
  local commit=$1 chunk=$2 origin=$3 benchmark=${4-${UPLOAD_CHUNK_BENCHMARK_ID-}} release backup previous
  release=$(release_path "$commit")
  [[ -d $release && -f $release/RELEASE.json ]] || die 'Prepare the release first.'
  [[ ! -e $BASE/current || -L $BASE/current ]] || die 'Refusing to replace an unknown current path.'
  if [[ -f $DROPIN ]]; then grep -Fxq '# Managed by ftp_web scripts/deploy.sh' "$DROPIN" || die 'Release drop-in is not owned by this script.'; fi
  if [[ -f $RELEASE_ENV ]]; then grep -Fxq '# Managed by ftp_web scripts/deploy.sh' "$RELEASE_ENV" || die 'Release environment is not owned by this script.'; fi
  [[ $chunk =~ ^[0-9]+$ ]] && ((chunk >= 1048576 && chunk <= 67108864)) || die 'Explicit tested chunk size must be 1–64 MiB.'
  [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || die 'Use the HTTPS origin without a path.'
  [[ -z $benchmark || $benchmark =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'Benchmark ID must be 1–64 safe identifier characters.'
  [[ -r /etc/ftp-web/ftp-web.env && -r /opt/ftp_web/pri_key.rsa && -r /opt/ftp_web/pub_key.rsa ]] || die 'Existing authentication material is missing.'
  install -d -o root -g root -m 0700 "$BACKUPS"
  backup=$(mktemp -d "$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-$commit-XXXXXXXX")
  # Backups may contain secrets, remain root-private, and are never printed or packed for Git.
  cp -a /etc/systemd/system/ftp-web.service "$backup/original.service"
  cp -a /etc/ftp-web/ftp-web.env "$backup/original.env"
  cp -a /opt/ftp_web/pri_key.rsa /opt/ftp_web/pub_key.rsa "$backup/"
  [[ ! -f $DROPIN ]] || cp -a "$DROPIN" "$backup/drop-in.conf"
  [[ ! -f $RELEASE_ENV ]] || cp -a "$RELEASE_ENV" "$backup/release.env"
  if [[ -L $BASE/current ]]; then readlink -f "$BASE/current" >"$backup/current"; else : >"$backup/current"; fi
  touch "$backup/READY"
  trap 'printf "Activation failed or interrupted; rolling back from %s\n" "$backup" >&2; trap - ERR HUP INT TERM; restore_backup "$backup"; exit 1' ERR HUP INT TERM
  # Stop only in activate mode. The offline database snapshot retains WAL-consistent metadata.
  systemctl stop "$SERVICE"
  if [[ -f $DATA/tasks.sqlite ]]; then
    install -d -m 0700 "$backup/database"
    for previous in tasks.sqlite tasks.sqlite-wal tasks.sqlite-shm; do [[ ! -f $DATA/$previous ]] || cp -a "$DATA/$previous" "$backup/database/"; done
  fi
  install -d -m 0755 /etc/systemd/system/ftp-web.service.d
  cat >"$RELEASE_ENV" <<EOF
# Managed by ftp_web scripts/deploy.sh
NODE_ENV=production
HOST=127.0.0.1
PORT=9090
FTP_WEB_DATA_DIR=$DATA
FTP_RSA_DIR=/opt/ftp_web
PUBLIC_ORIGIN=$origin
UPLOAD_CHUNK_SIZE=$chunk
EOF
  if [[ -n $benchmark ]]; then printf 'UPLOAD_CHUNK_BENCHMARK_ID=%s\n' "$benchmark" >>"$RELEASE_ENV"; fi
  chmod 0600 "$RELEASE_ENV"
  cat >"$DROPIN" <<EOF
# Managed by ftp_web scripts/deploy.sh
[Service]
WorkingDirectory=$BASE/current
ExecStart=
ExecStart=/usr/local/bin/node $BASE/current/index.js
EnvironmentFile=$RELEASE_ENV
ReadWritePaths=$DATA
# Reclaim file cache before the base unit's 384 MiB hard limit; measure latency under pressure.
MemoryHigh=256M
EOF
  chmod 0644 "$DROPIN"
  ln -s -- "$release" "$BASE/.current-activate-$$"
  mv -Tf -- "$BASE/.current-activate-$$" "$BASE/current"
  systemctl daemon-reload
  systemctl start "$SERVICE"
  health new
  trap - ERR HUP INT TERM
  printf 'Activated commit %s\nRollback: %s rollback %s\n' "$commit" "$0" "$backup"
}

case ${1-} in
  prepare) [[ $# == 4 ]] || die 'prepare COMMIT ARCHIVE SHA256'; prepare "$2" "$3" "$4" ;;
  activate) [[ $# == 4 || $# == 5 ]] || die 'activate COMMIT CHUNK_BYTES PUBLIC_ORIGIN [BENCHMARK_ID]'; activate "$2" "$3" "$4" "${5-${UPLOAD_CHUNK_BENCHMARK_ID-}}" ;;
  rollback) [[ $# == 2 ]] || die 'rollback BACKUP_DIR'; restore_backup "$2" ;;
  *) die 'Choose prepare, activate or rollback.' ;;
esac
