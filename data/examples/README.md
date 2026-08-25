# 데모용 시드 데이터

`data/users.json`과 `data/projects/*.json`은 실제 회사 데이터(직원 이메일·거래처명·조회
결과)가 들어있어서 git에 안 올린다(`.gitignore` 참고, 저장소가 Public이라 더욱 그렇다).
이 폴더는 그 대신 새 환경에서 `git clone`만으로 "부서별 접근 제어"가 실제로 어떻게
동작하는지 바로 눈으로 볼 수 있게 만든 가짜 시드 데이터다 — 이메일·데이터 전부 가짜.

## 써보는 법

```bash
cp data/examples/users.json data/users.json
cp data/examples/projects/*.json data/projects/
```

그다음 `.env`에 `ADMIN_EMAILS=admin@example.com`을 넣고(또는 사용자 관리 화면에서
`data/users.json`을 직접 편집해도 됨) 서버를 켜서, `DEV_FAKE_LOGIN=true`로 아래 세
이메일 중 하나로 로그인해보면 화면이 어떻게 달라지는지 확인할 수 있다:

| 이메일 | 부서 | 보이는 프로젝트 |
|---|---|---|
| `admin@example.com` | (관리자) | 전체 3개 |
| `sales@example.com` | 영업 | 공통 + 영업팀 데모 |
| `dev@example.com` | 개발 | 공통 + 개발팀 데모 |

실제 운영에 쓸 땐 이 파일들을 지우고 진짜 계정으로 다시 채우면 된다 — `data/users.json`과
`data/projects/`는 git에 안 잡히니 마음대로 바꿔도 이 예시 파일들엔 영향 없다.
