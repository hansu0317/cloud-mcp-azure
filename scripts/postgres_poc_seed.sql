-- crm_poc — PostgreSQL text-to-SQL 테스트용 샘플 스키마.
--
-- Dataverse(OData, 평면 엔티티)와 구조적으로 다른 관계형 스키마(FK, JOIN 여러 단계)를
-- 일부러 준비했다 — "다른 DB도 되는지" 검증할 때 Dataverse 전용 가정이 숨어 있지
-- 않은지 드러내기 위함이다. 기존 powerbi_gateway DB의 public/hr_onboarding
-- 스키마는 건드리지 않는다(별도 스키마로 완전히 격리).
--
-- 재실행 안전: 이 스크립트는 crm_poc 스키마를 통째로 지웠다가 다시 만든다.
-- crm_poc 밖(다른 스키마)에는 어떤 영향도 주지 않는다.

DROP SCHEMA IF EXISTS crm_poc CASCADE;
CREATE SCHEMA crm_poc;

SET search_path TO crm_poc;

-- ─── 고객사 ────────────────────────────────────────────────────────────────
CREATE TABLE customers (
    customer_id   SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    industry      TEXT,
    region        TEXT,
    created_at    DATE NOT NULL DEFAULT CURRENT_DATE
);
COMMENT ON TABLE customers IS '고객사(거래처)';

-- ─── 담당자 ────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
    contact_id    SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(customer_id),
    name          TEXT NOT NULL,
    title         TEXT,
    email         TEXT,
    phone         TEXT
);
COMMENT ON TABLE contacts IS '고객사 담당자';

-- ─── 제품 ─────────────────────────────────────────────────────────────────
CREATE TABLE products (
    product_id    SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    category      TEXT,
    unit_price    NUMERIC(12, 2) NOT NULL
);
COMMENT ON TABLE products IS '제품';

-- ─── 주문 ─────────────────────────────────────────────────────────────────
CREATE TABLE orders (
    order_id      SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(customer_id),
    order_date    DATE NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('신규', '진행중', '완료', '취소'))
);
COMMENT ON TABLE orders IS '주문';

-- ─── 주문 상세(품목) ─────────────────────────────────────────────────────────
CREATE TABLE order_items (
    order_item_id SERIAL PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(order_id),
    product_id    INTEGER NOT NULL REFERENCES products(product_id),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    unit_price    NUMERIC(12, 2) NOT NULL
);
COMMENT ON TABLE order_items IS '주문 상세(품목별 수량·단가)';

-- ─── 샘플 데이터 ──────────────────────────────────────────────────────────────
INSERT INTO customers (name, industry, region, created_at) VALUES
    ('한빛전자',     '제조', '서울', '2025-02-10'),
    ('은성물류',     '물류', '인천', '2025-03-22'),
    ('푸른소프트',   'IT/SW', '경기', '2025-04-15'),
    ('대한식품',     '식품', '부산', '2025-05-03'),
    ('서라벌건설',   '건설', '대구', '2025-06-19'),
    ('청담바이오',   '제약/바이오', '서울', '2025-07-08'),
    ('금강자동차부품', '제조', '광주', '2025-08-01'),
    ('해오름에너지', '에너지', '울산', '2025-09-12');

INSERT INTO contacts (customer_id, name, title, email, phone) VALUES
    (1, '김도윤', '구매팀장', 'kim.doyun@hanbit.example', '02-1000-1001'),
    (1, '이서연', '구매담당', 'lee.seoyeon@hanbit.example', '02-1000-1002'),
    (2, '박준혁', '물류팀장', 'park.junhyuk@eunseong.example', '032-2000-2001'),
    (3, '최유진', '대표',     'choi.yujin@푸른소프트.example', '031-3000-3001'),
    (3, '정민서', 'IT담당',   'jung.minseo@푸른소프트.example', '031-3000-3002'),
    (4, '한지훈', '영업팀장', 'han.jihoon@daehan.example', '051-4000-4001'),
    (5, '오세영', '자재구매', 'oh.seyoung@seorabeol.example', '053-5000-5001'),
    (6, '강나윤', 'R&D팀장',  'kang.nayoon@cheongdam.example', '02-6000-6001'),
    (7, '윤태양', '구매담당', 'yoon.taeyang@geumgang.example', '062-7000-7001'),
    (8, '임하은', '영업담당', 'lim.haeun@haeoreum.example', '052-8000-8001');

INSERT INTO products (name, category, unit_price) VALUES
    ('산업용 센서 모듈',   '전자부품', 128000.00),
    ('물류 추적 태그',     '전자부품', 5400.00),
    ('클라우드 라이선스(연)', '소프트웨어', 3600000.00),
    ('포장 자동화 키트',   '기계', 2150000.00),
    ('철강 프레임 세트',   '건자재', 890000.00),
    ('배터리 관리 시스템', '전자부품', 4200000.00);

INSERT INTO orders (customer_id, order_date, status) VALUES
    (1, '2026-05-02', '완료'),
    (1, '2026-06-14', '진행중'),
    (2, '2026-05-20', '완료'),
    (2, '2026-07-01', '신규'),
    (3, '2026-04-11', '완료'),
    (3, '2026-06-30', '완료'),
    (4, '2026-05-15', '취소'),
    (4, '2026-07-10', '진행중'),
    (5, '2026-03-28', '완료'),
    (6, '2026-06-05', '완료'),
    (6, '2026-07-22', '신규'),
    (7, '2026-05-09', '완료'),
    (8, '2026-06-18', '진행중'),
    (8, '2026-07-25', '신규'),
    (5, '2026-08-01', '신규');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 20, 128000.00), (1, 2, 100, 5400.00),
    (2, 3, 1, 3600000.00),
    (3, 2, 300, 5300.00), (3, 4, 2, 2150000.00),
    (4, 2, 150, 5400.00),
    (5, 3, 2, 3600000.00), (5, 6, 1, 4200000.00),
    (6, 3, 1, 3600000.00),
    (7, 5, 4, 890000.00),
    (8, 5, 6, 880000.00),
    (9, 4, 1, 2150000.00), (9, 1, 10, 128000.00),
    (10, 6, 3, 4100000.00),
    (11, 3, 1, 3600000.00),
    (12, 1, 15, 127000.00),
    (13, 5, 2, 890000.00),
    (14, 2, 500, 5200.00),
    (15, 5, 8, 890000.00), (15, 4, 1, 2150000.00);
