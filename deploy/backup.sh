#!/bin/sh
# Daily compressed dump of the transit database; keeps BACKUP_KEEP_DAYS days of dumps.
# Restore: pg_restore --clean --if-exists -d transit /backups/transit-<stamp>.dump
set -u
while true; do
  stamp=$(date -u +%Y%m%dT%H%MZ)
  partial="/backups/transit-$stamp.dump.partial"
  if pg_dump --format=custom --file="$partial"; then
    mv "$partial" "/backups/transit-$stamp.dump"
    echo "backup written: transit-$stamp.dump"
  else
    rm -f "$partial"
    echo "backup failed" >&2
  fi
  find /backups -name 'transit-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-7}" -delete
  sleep 86400
done
