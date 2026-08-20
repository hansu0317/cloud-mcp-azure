# Local 프로필 GPU 가속 시도 기록 (2026-08-19) — 실패, CPU로 확정

이 노트북(Intel Arc B390 GPU 내장)에서 Local 프로필(Ollama)을 GPU로 가속해보려 시도했고, **안 됨을 확인**했다. 다시 시도하지 않도록, 또는 새 하드웨어/드라이버가 나왔을 때 참고할 수 있도록 근거를 남긴다.

## 결론

**Local 프로필은 CPU(기존 Ollama, 포트 11434)로 그대로 유지한다.** `.env`/`LOCAL_LLM_BASE_URL` 등 실제 설정은 이번 시도로 전혀 바뀌지 않았다.

## 시도한 것과 결과

| 시도 | 결과 |
|---|---|
| [IPEX-LLM](https://github.com/intel/ipex-llm) 포터블 Ollama(`ollama-ipex-llm-*-win.zip`)로 교체, `OLLAMA_INTEL_GPU=1`로 GPU 백엔드(oneAPI/SYCL) 활성화 | GPU 자체는 정상 인식(`Intel Arc B390 GPU`, VRAM 17.6GB, SYCL 디바이스 목록에 정상 표시) |
| 빌드 2종(2025-06-30, 2025-07-25) × 모델 2종(qwen3:8b, sqlcoder:7b)으로 실제 추론 시도 | **전부 동일한 지점에서 크래시**: `ggml_sycl_op_mul_mat`에서 `could not create a primitive descriptor for a matmul primitive` (SYCL/oneDNN 에러) |
| Intel 그래픽 드라이버 업데이트(32.0.101.8622 → 32.0.101.8974, Level Zero 1.14 → 1.15) 후 재시도 | 동일 에러, 변화 없음 |
| 드라이버 업데이트 전에 쌓인 컴퓨트 커널 캐시(`%LOCALAPPDATA%\NEO\neo_compiler_cache`) 삭제 후 재시도 | 동일 에러, 변화 없음 |
| GitHub/Intel 커뮤니티에서 동일 에러 검색 | [intel/ipex-llm#13223](https://github.com/intel/ipex-llm/issues/13223) 등에서 A770/B580/B60/Lunar Lake 등 **여러 세대의 Intel Arc GPU에서 공통으로 보고된, 끝내 해결 안 된 이슈**임을 확인 |

## 근본 원인

**`intel/ipex-llm` 저장소가 2026-01-28에 archived(관리 종료, 읽기 전용) 처리됐다.** 위 GitHub 이슈의 최초 신고(#13221)는 답변 없이 닫혔고, 재신고(#13223)도 메인테이너 응답이 없다 — 우리가 시도한 것과 동일한 환경변수(`OLLAMA_NUM_GPU=999`, `ZES_ENABLE_SYSMAN=1`)와 `SYCL_CACHE_PERSISTENT=1`까지 다른 사용자가 이미 시도했지만 동일하게 실패했다. 즉 이건 이 PC나 이번 설정의 문제가 아니라 **프로젝트 자체가 관리 종료되며 영구히 미해결로 남은 버그**다.

## 나중에 다시 검토한다면

- **드라이버 업데이트나 캐시 삭제로는 해결 안 됨을 이미 확인했으므로 그 경로는 재시도하지 않는다.**
- 재도전할 유일한 방향은 SYCL이 아닌 **다른 컴퓨트 스택(예: OpenVINO GenAI)** — 이건 "Ollama 갈아끼우기" 수준이 아니라 API 계약부터 다시 맞춰야 하는 별도 프로젝트다.
- 또는 `intel/ipex-llm`이 새 관리자에게 포크되거나 archived가 풀리는 등 상류 상황이 바뀌면 재검토.
- 하드웨어를 NVIDIA GPU로 바꾸는 경우엔 이 문서의 결론이 적용되지 않는다(vLLM 등 CUDA 경로는 전혀 다른 이야기).

## 남은 파일 정리

테스트에 쓴 파일들은 프로젝트 저장소 밖(`C:\Users\hansu\tools\`)에 있고 두 저장소와 무관하다 — 필요 없으면 그 폴더 전체를 지워도 된다:
- `C:\Users\hansu\tools\ollama-ipex-llm-win.zip`, 그 압축 해제 파일들(2025-07-25 빌드)
- `C:\Users\hansu\tools\v0630\` (2025-06-30 빌드 전체)

`crm-ai-chat-mcp\.mcp.json`(MCP 데모용 로컬 설정)과 `crm-ai-chat-mcp\scripts\demo_web.py`(MCP 데모 웹페이지)는 이 GPU 시도와 무관한 별개 작업 산출물이라 그대로 둔다.
