"""crm_poc PostgreSQL 테스트 스키마를 (재)생성한다.

목적: backend/dataverse.py 하나에만 맞춰진 지금 구조가 실제로 "다른 DB에도
일반화 가능한지" 검증할 때 쓸 샘플 데이터베이스를 준비한다. Dataverse(OData,
평면 엔티티)와 구조가 다른 관계형 스키마(FK 여러 단계 JOIN)를 일부러 골랐다.

기존 powerbi_gateway DB의 public/hr_onboarding 스키마는 절대 건드리지 않는다 —
scripts/postgres_poc_seed.sql이 만드는 crm_poc 스키마 하나로 완전히 격리된다.

실행:
  python scripts/setup_postgres_poc.py

필요 환경변수(.env, 이 저장소 .env.example 참고):
  POSTGRES_POC_HOST / POSTGRES_POC_PORT / POSTGRES_POC_DB /
  POSTGRES_POC_USER / POSTGRES_POC_PASSWORD
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg2
except ImportError:
    print("psycopg2가 설치되어 있지 않습니다: python -m pip install psycopg2-binary", file=sys.stderr)
    raise SystemExit(1)

REQUIRED_VARS = (
    "POSTGRES_POC_HOST",
    "POSTGRES_POC_PORT",
    "POSTGRES_POC_DB",
    "POSTGRES_POC_USER",
    "POSTGRES_POC_PASSWORD",
)


def main() -> None:
    missing = [name for name in REQUIRED_VARS if not os.environ.get(name)]
    if missing:
        print(f"다음 환경변수가 필요합니다: {', '.join(missing)} (.env 확인)", file=sys.stderr)
        raise SystemExit(1)

    sql_path = Path(__file__).parent / "postgres_poc_seed.sql"
    sql = sql_path.read_text(encoding="utf-8")

    conn = psycopg2.connect(
        host=os.environ["POSTGRES_POC_HOST"],
        port=os.environ["POSTGRES_POC_PORT"],
        dbname=os.environ["POSTGRES_POC_DB"],
        user=os.environ["POSTGRES_POC_USER"],
        password=os.environ["POSTGRES_POC_PASSWORD"],
    )
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql)
        print(f"crm_poc 스키마 생성 완료 — {os.environ['POSTGRES_POC_DB']}@{os.environ['POSTGRES_POC_HOST']}")

        with conn.cursor() as cur:
            cur.execute(
                "select table_name from information_schema.tables "
                "where table_schema = 'crm_poc' order by table_name;"
            )
            tables = [row[0] for row in cur.fetchall()]
            print(f"테이블 {len(tables)}개: {', '.join(tables)}")
            for table in tables:
                cur.execute(f'select count(*) from crm_poc."{table}";')
                (count,) = cur.fetchone()
                print(f"  - {table}: {count}행")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
