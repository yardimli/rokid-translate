#!/usr/bin/env bash
# Run as the SSH user who owns the checkout, not with sudo. Only installation uses sudo.
set -Eeuo pipefail
update_apache=false
pull=true
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=false ;;
    --update-apache) update_apache=true ;;
    --help|-h)
      echo 'Usage: bash server/deploy/update.sh [--no-pull] [--update-apache]'
      echo 'Deploys within /opt/rokid-translate; state is kept in server/.'
      echo '--update-apache replaces the already-enabled translate-ssl.conf template only.'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -ne 0 ]] || fail 'Run as your checkout-owning SSH user, without sudo.'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
for command in git sudo npm curl flock; do command -v "$command" >/dev/null || fail "Missing $command"; done
[[ -x /usr/bin/node ]] || fail 'Install Node 22+ at /usr/bin/node.'
[[ $(/usr/bin/node -p 'Number(process.versions.node.split(".")[0]) >= 22') == true ]] || fail 'Node 22+ required.'
[[ -z $(git status --porcelain) ]] || fail 'Checkout has local changes/untracked files. Commit or move them before deploying.'
[[ -n $(git branch --show-current) ]] || fail 'Checkout must be on a branch with an upstream.'
if $pull; then
  git pull --ff-only
  # Execute the updated script, not the pre-pull version Bash had already loaded.
  args=(--no-pull)
  $update_apache && args+=(--update-apache)
  exec bash "$repo/server/deploy/update.sh" "${args[@]}"
fi
exec 9>"$(git rev-parse --git-path rokid-deploy.lock)"
flock -n 9 || fail 'Another deployment from this checkout is running.'
sudo -v
[[ $repo == /opt/rokid-translate ]] || fail 'Clone this checkout at /opt/rokid-translate (the service uses this path).'
root="$repo/.deploy"
state="$repo/server"
unit=/etc/systemd/system/rokid-test.service
site=/etc/apache2/sites-available/translate-ssl.conf
sudo test -f "$state/.env" || fail "Existing $state/.env is required; see DEPLOY.md."
sudo test -f "$unit" || fail 'Existing rokid-test.service is required.'
id rokid-test >/dev/null || fail 'Existing rokid-test service account is required.'
was_active=false
if sudo systemctl is-active --quiet rokid-test; then was_active=true; fi
sudo -u rokid-test test -w "$state/logs" || fail 'Service needs write access to server/logs; see migration instructions.'
sudo -u rokid-test test -w "$state/recordings" || fail 'Service needs write access to server/recordings; see migration instructions.'
[[ -z $(sudo systemctl show -p DropInPaths --value rokid-test) ]] || fail 'Custom systemd drop-ins exist; review/remove old path overrides before migrating.'
sudo apache2ctl configtest
if $update_apache; then
  sudo test -f "$site" || fail 'translate-ssl.conf must already exist; see DEPLOY.md for customized/Certbot sites.'
  sudo test /etc/apache2/sites-enabled/translate-ssl.conf -ef "$site" || fail 'translate-ssl.conf must already be enabled.'
fi
# Verify the actual service environment without printing tokens or sourcing .env as shell code.
sudo -u rokid-test /usr/bin/node --env-file="$state/.env" "$repo/server/deploy/check-config.mjs"
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cp -a "$repo/server/src" "$repo/server/public" "$repo/server/test" "$repo/server/deploy" "$stage/"
cp "$repo/server/package.json" "$repo/server/package-lock.json" "$stage/"
(
  cd "$stage"
  npm ci --omit=dev
  npm test
)
release="$root/releases/$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)-$$"
sudo install -d -m 755 "$root/releases" "$release"
sudo cp -a "$stage/src" "$stage/public" "$stage/node_modules" "$stage/package.json" "$stage/package-lock.json" "$release/"
sudo chown -R root:root "$release"
sudo chmod -R a+rX "$release"
backup="$release/deploy-backup"
sudo install -d -m 700 "$backup"
sudo cp -a "$unit" "$backup/service"
old_current=''
if sudo test -L "$root/current"; then
  old_current=$(sudo readlink "$root/current")
elif sudo test -e "$root/current"; then
  fail "$root/current exists but is not a symlink; refusing to replace it."
fi
if $update_apache; then sudo cp -a "$site" "$backup/apache"; fi
changed=false
rollback() {
  code=$?
  trap - ERR INT TERM
  set +e
  if $changed; then
    echo 'Deployment failed; restoring the previous service and Apache configuration.' >&2
    if [[ -n $old_current ]]; then
      sudo ln -sfn "$old_current" "$root/current.next"
      sudo mv -Tf "$root/current.next" "$root/current"
    else
      sudo rm -f "$root/current"
    fi
    sudo cp -a "$backup/service" "$unit"
    if $update_apache; then sudo cp -a "$backup/apache" "$site"; fi
    sudo systemctl daemon-reload
    if $was_active; then sudo systemctl restart rokid-test; else sudo systemctl stop rokid-test; fi
    sudo apache2ctl configtest && sudo systemctl reload apache2
    sudo systemctl is-active rokid-test
    echo "Previous files restored; check service health and journal. Backup: $backup" >&2
  fi
  exit "${code:-1}"
}
trap rollback ERR
trap 'false' INT TERM
changed=true
# State lives in server/; tested releases live in the ignored .deploy directory.
sudo install -m 644 "$repo/server/deploy/rokid-translate.service" "$unit"
if $update_apache; then sudo install -m 644 "$repo/server/deploy/translate-ssl.conf" "$site"; fi
sudo apache2ctl configtest
sudo ln -sfn "$release" "$root/current.next"
sudo mv -Tf "$root/current.next" "$root/current"
sudo systemctl daemon-reload
sudo systemctl restart rokid-test
healthy=false
for attempt in {1..15}; do
  if curl --silent --show-error --fail --max-time 2 http://127.0.0.1:8787/healthz 2>/dev/null | \
    /usr/bin/node "$repo/server/deploy/check-health.mjs"; then healthy=true; break; fi
  sleep 1
done
$healthy || { echo 'New release failed localhost health check.' >&2; false; }
sudo systemctl is-active --quiet rokid-test
sudo systemctl reload apache2
# Exercise this server's TLS vhost locally, without DNS/CDN routing or disabling certificate checks.
curl --silent --show-error --fail --max-time 10 \
  --resolve translate.playground.computer:443:127.0.0.1 \
  https://translate.playground.computer/healthz | /usr/bin/node "$repo/server/deploy/check-health.mjs"
trap - ERR INT TERM
echo "Deployed $(git rev-parse --short=12 HEAD) to $release"
echo 'Reload the dashboard and re-enable translation. Existing sessions end during restart.'
echo "Previous service/config backup: $backup (old releases are retained)."
