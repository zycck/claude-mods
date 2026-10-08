# Claude Code 모드

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Português](README.pt-BR.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

## plan-progress

Claude Code 입력창 위에 실시간 진행 막대를 표시합니다. Claude가 작업을 단계와 스텝으로 나누고, 작업이 진행될수록 막대가 채워집니다. 각 작업의 서브에이전트는 막대 아래에 표시됩니다.

![plan-progress: 에이전트가 있는 두 작업, 질문, 오류, 도중에 바뀐 계획, 두 작업 완료](media/plan-progress.gif)

[소리 포함 영상 (MP4, 14초)](media/plan-progress.mp4)

- 작업마다 한 줄: 상태, 제목, 막대, 퍼센트, 닫기 버튼
- 막대 위 라벨에 현재 단계와 스텝 표시, 마우스를 올리면 경과 시간 표시
- 단계는 캡슐, 스텝은 점으로 표시, 마우스를 올리면 도달 시각 표시
- 완료된 막대는 초록색이 되고 총 소요 시간을 표시, 30초 후 저절로 사라짐 (`/config`의 `doneBarSeconds`)
- 네 가지 상태: 진행 중, 입력 필요, 오류, 완료
- 서브에이전트마다 작업 아래에 한 줄: 이름, 모델과 effort, 사용 중인 도구, 시간
- 계획은 도중에 바꿀 수 있으며, 완료된 스텝은 제목 기준으로 유지됩니다
- 막대는 세션별로 저장되어 세션을 다시 열면 복원됩니다
- 질문, 오류, 완료 시 짧은 알림음
- 데스크톱 앱과 터미널 모두 지원
- 터미널에서는 `auto` 테마일 때 GNOME 데스크톱의 라이트/다크를 따르고, 현재 Omarchy 테마의 색을 사용

### 설치

Claude Code 2.1.286 이상이 필요합니다(`claude --version`으로 확인, `claude update`로 업데이트). 이전 버전에서는 훅 모듈이 로드되지 않아 바가 표시되지 않으며, 시작 시 `plan-progress: hooks module did not load`가 표시됩니다.

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

업데이트:

```
claude plugin marketplace update zycck-mods
claude plugin update plan-progress@zycck-mods
```

### 명령어

- `/progress` 막대 표시/숨기기
- `/progress-clear` 모든 막대 삭제
- `/progress-agents` 막대 아래의 에이전트 줄을 접거나 다시 표시 (막대의 ✕ 옆 화살표 버튼은 그 막대만)
- `/plan-progress-autoclose` 완료된 막대의 자동 닫기를 끄거나 다시 켬 (선택은 세션 간에 유지)

하단의 **Progress** 버튼은 `/progress`와 같은 동작을 합니다.

### 동작 방식

모드는 `plan_progress` 도구를 등록합니다. Claude는 계획을 한 번 보낸 뒤 `{id, next: true}`, `{id, done: ["Routes"]}` 같은 짧은 업데이트를 보냅니다. 없는 스텝 이름은 해당 막대의 스텝 목록과 함께 거부됩니다. plan mode에서 승인한 계획은 막대 `plan`이 됩니다. 에이전트 줄은 엔진 이벤트에서 만들어지며 토큰을 쓰지 않습니다.

데스크톱에서 막대는 SVG 이미지이고 그 위에 호버 레이어가 있습니다. 터미널에서는 문자 그리드이며 Claude가 작업하는 동안에만 애니메이션됩니다.

### 테스트

`plugins/plan-progress/tests`는 실제 모듈을 스텁 엔진에서 실행합니다: `node compile.cjs ../hooks/register.tsx register.mjs` 후 `node regress.mjs`와 `node scenarios.mjs`.

## 라이선스

MIT
