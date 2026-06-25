# Power BI 산출물 — Quali CRM 영업 분석

Azure Dataverse(`new_q3` 영업기회) 데이터를 Power BI에서 분석하기 위한 측정값·보고서 자산입니다.

> ⚠️ **참고**: 현재 이 저장소에는 Power BI MCP 서버가 연결되어 있지 않습니다(`.mcp.json`은 `dataverse` 단일 구성).
> 따라서 본 자산은 **Dataverse MCP `read_query`로 실조회한 데이터를 근거로 수기 생성**한 정적 산출물입니다.
> Power BI Service에 자동 배포하려면 별도로 Power BI/Fabric MCP 또는 REST API 연동이 필요합니다.

## 구성

| 파일 | 내용 |
|---|---|
| [measures.dax](measures.dax) | DAX 측정값 라이브러리 (KPI·승률·가중 파이프라인·시간 인텔리전스) |
| [report_summary.md](report_summary.md) | 실데이터 기반 영업 현황 요약 보고서 |

## Power BI Desktop 연동 방법

1. **데이터 가져오기** → `Dataverse` 커넥터 선택
2. 환경 URL 입력: `https://quali.crm5.dynamics.com`
3. 테이블 선택: `new_q3`(영업기회), 필요 시 `new_q1`(거래처), `new_part`(부품)
4. **모델 보기**에서 [measures.dax](measures.dax)의 측정값을 새 측정값으로 추가
5. (선택) 날짜 테이블 `Calendar` 생성 후 `new_q3[createdon]`과 관계 설정 → 시간 인텔리전스 측정값 활성화

## CHOICE 컬럼 주의사항

Dataverse 선택값(CHOICE)은 커넥터에서 **숫자 값**과 **라벨**이 분리되어 들어옵니다.
DAX는 라벨(`new_p_resultname` = "성공"/"실패" 등) 기준으로 작성했으니, 가져온 모델의 라벨 열 이름에 맞춰 조정하세요.

## 권장 시각화 (보고서 페이지 구성)

1. **KPI 카드 행**: 활성 영업기회 수 · 승률 · 예상금액 합계 · 가중 파이프라인
2. **영업단계 깔때기(Funnel)**: new_p_mtype별 건수
3. **제품유형 도넛**: new_p_ptype별 비중
4. **승률 게이지**: [승률] 측정값
5. **월별 추세 라인**: createdon 기준 영업기회 수 / 예상금액
