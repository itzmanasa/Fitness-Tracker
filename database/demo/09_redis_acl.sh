#!/usr/bin/env bash
# DEMO 9b - Redis ACL administration and member-account smoke check.
# Needs Redis 6+ (or a Memurai build with ACL support) and redis-cli 6+.
# The recovery account is used only for ACL SETUSER / CONFIG REWRITE.
# Read both passwords silently before running; never put either on a command line.
# See DEMO_GUIDE.md for the prompt-based invocation.
#   bash database/demo/09_redis_acl.sh
set -e
: "${REDIS_HOST:=127.0.0.1}"
: "${REDIS_PORT:=6379}"
: "${REDIS_RECOVERY_PASSWORD:?set REDIS_RECOVERY_PASSWORD first}"
: "${REDIS_MEMBER_PASSWORD:?set REDIS_MEMBER_PASSWORD first}"
recovery() {
    REDISCLI_AUTH="$REDIS_RECOVERY_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --user ft_redis_recovery "$@"
}

member() {
    REDISCLI_AUTH="$REDIS_MEMBER_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --user ft_redis_member "$@"
}

echo "== configure the member user: required application commands and FitTrack keys only"
# Feed the password as the final ACL argument over stdin so it is not placed in
# redis-cli's process arguments. Reset command, key, and channel rules first.
printf '>%s' "$REDIS_MEMBER_PASSWORD" | REDISCLI_AUTH="$REDIS_RECOVERY_PASSWORD" \
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --user ft_redis_recovery -x ACL SETUSER ft_redis_member on nocommands resetkeys resetchannels \
    '~fittrack:journal:*' '~fittrack:photos:*' '~fittrack:sensors:*' '~fittrack:activity:*' \
    '+get' '+set' '+mget' '+del' '+scan' \
    '+xadd' '+xrevrange' '+hgetall' '+hincrby' '+hincrbyfloat' '+ping'

echo "== persist ACL in the active redis.conf"
recovery CONFIG REWRITE

CHECK_KEY="fittrack:journal:acl-demo:check-$$"
trap 'member DEL "$CHECK_KEY" >/dev/null 2>&1 || true' EXIT
echo "== member CAN write its journal"
member SET "$CHECK_KEY" '{"title":"acl check"}'
echo "== member CAN read it back"
member GET "$CHECK_KEY"
echo "== clean up only this script's temporary key"
member DEL "$CHECK_KEY"
trap - EXIT
