#!/usr/bin/env bash
# DEMO 9b - Redis role-based access: a MEMBER-level Redis user.
# Needs Redis 6+ (or a Memurai build with ACL support) and redis-cli 6+.
# Read the password silently before running; do not place it on a command line.
# See DEMO_GUIDE.md for the prompt-based invocation.
#   bash database/demo/09_redis_acl.sh
set -e
: "${REDIS_HOST:=127.0.0.1}"
: "${REDIS_PORT:=6379}"
: "${REDIS_MEMBER_PASSWORD:?set REDIS_MEMBER_PASSWORD first}"
admin() {
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "$@"
}

member() {
    REDISCLI_AUTH="$REDIS_MEMBER_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --user ft_redis_member "$@"
}

echo "== configure the member user: required application commands and FitTrack keys only"
# Feed the password as the final ACL argument over stdin so it is not placed in
# redis-cli's process arguments. resetcommands prevents old grants accumulating.
printf '>%s' "$REDIS_MEMBER_PASSWORD" | redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -x ACL SETUSER ft_redis_member on nocommands resetkeys \
    '~fittrack:journal:*' '~fittrack:photos:*' '~fittrack:sensors:*' '~fittrack:activity:*' \
    '+get' '+set' '+mget' '+del' '+scan' \
    '+xadd' '+xrevrange' '+hgetall' '+hincrby' '+hincrbyfloat' '+ping'

echo "== persist ACL in the active redis.conf (default user remains unchanged)"
admin CONFIG REWRITE

CHECK_KEY="fittrack:journal:0:acl-check-$$"
trap 'admin DEL "$CHECK_KEY" >/dev/null 2>&1 || true' EXIT
echo "== member CAN write its journal"
member SET "$CHECK_KEY" '{"title":"acl check"}'
echo "== member CAN read it back"
member GET "$CHECK_KEY"
echo "== member CANNOT write outside FitTrack keys"
admin ACL DRYRUN ft_redis_member SET secret:admin-note hello
echo "== member CANNOT run dangerous commands"
admin ACL DRYRUN ft_redis_member FLUSHALL
admin ACL DRYRUN ft_redis_member KEYS '*'
echo "== clean up only this script's temporary key"
