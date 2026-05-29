#!/usr/bin/env bash
# oracle_reader 계정 생성 — Oracle 서버(Python)가 TSDB를 SELECT 전용으로 접근하기 위한 계정
set -euo pipefail

DB="${TSDB_DATABASE:-ds_historian}"
SUPERUSER="${TSDB_USER:-historian}"
READER_PASSWORD="${ORACLE_READER_PASSWORD:-oracle_reader_pass}"

psql -U "$SUPERUSER" -d "$DB" <<SQL
CREATE ROLE oracle_reader WITH LOGIN PASSWORD '$READER_PASSWORD';
GRANT CONNECT ON DATABASE $DB TO oracle_reader;
GRANT USAGE ON SCHEMA public TO oracle_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO oracle_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO oracle_reader;
SQL

echo "oracle_reader account created successfully."
