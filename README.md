# DS Vision Historian 서버

MQTT Broker에서 8종 이벤트를 구독하여 TimescaleDB(시계열 DB)에 적재하는 데이터 수집 서버.  
Oracle 서버 및 AI 서버에 원시 데이터를 공급하는 **읽기 전용 데이터 수집 역할**만 수행합니다.

## 기술 스택

| 항목 | 내용 |
|---|---|
| Language | TypeScript (Node.js) |
| MQTT | mqtt.js (v5.0, QoS 1/2) |
| Database | TimescaleDB (PostgreSQL 16) |
| DB 드라이버 | pg (node-postgres) |
| 로깅 | pino |
| 테스트 | vitest |

## 디렉토리 구조

```
Historian/
├── src/
│   ├── config/       # 환경변수 로딩 및 검증
│   ├── db/           # pg Pool, TimescaleDB 스키마, 배치 INSERT
│   ├── handlers/     # 8종 이벤트 핸들러
│   ├── mqtt/         # MQTT 클라이언트, 메시지 라우터, 구독 목록
│   └── utils/        # 재연결 백오프, 장비 캐시, 로거
├── test/             # 단위 테스트
└── scripts/          # 라이브 체크 스크립트 (H5~H10)
```

## 핵심 정책

**PASS drop 정책**: `overall_result = PASS && fail_count = 0` 이면 detail 그룹(inspection_detail, geometric, bga, surface, singulation)을 적재하지 않고 summary + process만 저장하여 적재 부하 ~60% 감소.

**재연결 백오프**: `[1, 2, 5, 15, 30, 60]`초 수열 + jitter ±20%

**LOT_END enrichment**: STATUS_UPDATE의 `recipe_id`, `operator_id`를 인메모리 캐시에 유지하여 LOT_END 적재 시 주입.

## TimescaleDB 테이블 (8개 Hypertable)

| 테이블 | 이벤트 | Retention |
|---|---|---|
| `heartbeats` | HEARTBEAT | 90일 |
| `status_updates` | STATUS_UPDATE | 90일 |
| `inspection_results` | INSPECTION_RESULT | 365일 |
| `lot_ends` | LOT_END | 365일 |
| `hw_alarms` | HW_ALARM | 365일 |
| `recipe_changes` | RECIPE_CHANGED | 365일 |
| `control_commands` | CONTROL_CMD | 365일 |
| `oracle_analyses` | ORACLE_ANALYSIS | 365일 |

## 실행 방법

```bash
cd Historian

# 환경변수 설정
cp .env.example .env

# TimescaleDB 실행
docker compose up -d

# 서버 실행 (개발)
npm install
npm run dev

# 빌드 후 실행
npm run build
npm start
```

## 포트

| 서비스 | 포트 |
|---|---|
| TimescaleDB | 5434 |

## 테스트

```bash
npm test
```
