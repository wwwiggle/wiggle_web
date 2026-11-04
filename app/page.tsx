import { Logo } from "./components/Logo";
import { LandingCodeForm } from "./components/LandingCodeForm";
import { studentAppEnabled } from "@/lib/product-mode";

/* 2026-09-07 오리 전시관 대문 (`docs/design-assets/gallery/selected-reference.png`).
   그림은 개별 에셋으로 배치하고 제목·버튼·입력칸은 실제 HTML이다. 전시 그림과 도형 표식은
   제품 소개용 장식이며 실제 학생 작품이나 `Lesson.seed` 데이터가 아니다. */
const EXHIBITS = [
  { id: "rocket", alt: "크레용으로 그린 로켓과 우주 비행사", mark: "/landing-gallery/icons/rocket.svg" },
  { id: "whale", alt: "크레용으로 그린 고래와 바닷속 친구들", mark: "/landing-gallery/icons/whale.svg" },
  { id: "house", alt: "크레용으로 그린 빨간 지붕 집과 꽃밭", mark: "/landing-gallery/icons/house.svg" },
];

/* 그림책 공방(2026-11-04, lib/product-mode.ts): 학생 입장 대신 선생님이 책을 만들고 주문하는 길을 보인다. */
const STUDIO_STEPS = [
  { icon: "book-discover", title: "사진·스캔·PDF 올리기", body: "아이들 그림을 찍거나 스캔해 올리거나, 완성한 PDF를 그대로 올려요" },
  { icon: "different-ideas", title: "그림책 편집", body: "쪽 순서를 바꾸고, 글과 그림을 더하고, 표지를 꾸며요" },
  { icon: "question", title: "주문·결제", body: "하드커버 그림책으로 인쇄해 학교로 보내 드려요" },
];

const REASONS = [
  { icon: "different-ideas", title: "모두 다른 답", body: "같은 시작에서도 생각은 달라져요" },
  { icon: "question", title: "AI는 대신 그리지 않아요", body: "필요할 때만 질문으로 도와요" },
  { icon: "book-discover", title: "비교보다 발견", body: "선생님과 서로의 과정을 살펴봐요" },
];

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const teacherAuthFailed = params.teacherAuth === "failed";
  const studio = !studentAppEnabled();
  return (
    <main className="landing gallery-landing">
      <nav className="topbar">
        <Logo />
        <a className="button secondary teacher-link" href="/teacher">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" />
          </svg>
          {studio ? "선생님 로그인" : "교사 수업 열기"}
        </a>
      </nav>

      <section className="gallery-hero">
        <div className="gallery-copy">
          {studio ? <>
            <p className="eyebrow landing-eyebrow">꿈틀 그림책 공방 · 학교 그림책 인쇄</p>
            <h1 className="landing-headline"><span>아이들 그림으로</span> <strong>진짜 그림책을 만들어요</strong></h1>
            <p className="landing-subtitle">사진·스캔·PDF를 올려 편집하고, 하드커버 책으로 주문하세요.</p>
          </> : <>
            <p className="eyebrow landing-eyebrow">AI 그림 학습 · 교실 창작 코칭</p>
            <h1 className="landing-headline"><span>오늘은</span> <strong>어떤 생각을 그려볼까요?</strong></h1>
            <p className="landing-subtitle">함께 그리고, 서로의 생각을 발견하는 교실.</p>
          </>}
        </div>

        <div className="gallery-stage">
          <div className="gallery-wall">
            {EXHIBITS.map((exhibit) => (
              <div className="gallery-exhibit" key={exhibit.id}>
                <figure className="gallery-frame">
                  <div className="gallery-wire" aria-hidden="true"><i className="gallery-pin" /></div>
                  <img
                    className="gallery-frame__rim"
                    src="/landing-gallery/frame-blue-960.webp"
                    width={960}
                    height={720}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                  />
                  <img
                    className="gallery-frame__art"
                    src={`/landing-gallery/artwork-${exhibit.id}-480.webp`}
                    srcSet={`/landing-gallery/artwork-${exhibit.id}-480.webp 480w, /landing-gallery/artwork-${exhibit.id}-960.webp 960w`}
                    sizes="(max-width:600px) 74vw, 320px"
                    width={960}
                    height={720}
                    alt={exhibit.alt}
                    loading="lazy"
                    decoding="async"
                  />
                </figure>
                <p className="gallery-shape-chip" aria-hidden="true">
                  ○<i>→</i>▽<i>→</i>
                  <img src={exhibit.mark} width={20} height={20} alt="" loading="lazy" />
                </p>
              </div>
            ))}
          </div>

          <img
            className="gallery-duck"
            src="/landing-gallery/duck-painter-1200.webp"
            srcSet="/landing-gallery/duck-painter-640.webp 640w, /landing-gallery/duck-painter-1200.webp 1200w"
            sizes="(max-width:640px) 62vw, (max-width:1023px) 40vw, 420px"
            width={1200}
            height={1200}
            alt="붓과 팔레트를 든 노란 오리 화가"
            fetchPriority="high"
            decoding="async"
          />

          <img
            className="gallery-leaves gallery-decoration"
            src="/landing-gallery/leaves-320.webp"
            width={320}
            height={336}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />

          <div className="gallery-entry">
            {studio ? <>
              <div className="gallery-student-tag">
                <img src="/landing-gallery/icons/star.svg" width={22} height={22} alt="" aria-hidden="true" />
                <b>선생님</b>
                <span>구글 계정으로 바로 시작해요</span>
              </div>
              <div className="landing-code-card studio-start-card">
                <h2 className="landing-code-card-title">그림책 만들기</h2>
                <ol className="studio-steps">
                  {STUDIO_STEPS.map((step, index) => <li key={step.title}><b>{index + 1}. {step.title}</b><span>{step.body}</span></li>)}
                </ol>
                <a className="button primary full" href="/teacher">그림책 만들러 가기</a>
              </div>
            </> : <>
              <div className="gallery-student-tag">
                <img src="/landing-gallery/icons/star.svg" width={22} height={22} alt="" aria-hidden="true" />
                <b>학생</b>
                <span>수업 코드로 바로 참여해요</span>
              </div>
              <div className="landing-code-card">
                <h2 className="landing-code-card-title">수업 코드 입력</h2>
                <LandingCodeForm />
              </div>
              <p className="gallery-trust-note">
                <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3 5 6v5c0 4.8 2.9 8.2 7 10 4.1-1.8 7-5.2 7-10V6l-7-3Z" />
                  <path d="m9 12 2 2 4-5" />
                </svg>
                학생 이메일 없이 안전하게
              </p>
            </>}
            {teacherAuthFailed && (
              <aside className="teacher-auth-notice" role="alert">
                <b>구글 로그인이 되지 않았어요.</b>
                <span>
                  학교 구글 계정은 학교 관리자가 외부 서비스 접속을 막아 둔 경우가 있어요.
                  <br />개인 Gmail로 다시 시도하거나, 학교 관리자에게 이 서비스 허용을 요청해 주세요.
                </span>
                <a className="button secondary" href="/api/auth/google/start?return_to=%2Fteacher">다른 계정으로 다시 로그인</a>
              </aside>
            )}
          </div>
        </div>
      </section>

      <section className="gallery-reasons" aria-labelledby="gallery-reasons-title">
        <h2 id="gallery-reasons-title">{studio ? <>꿈틀 그림책이<br />하는 일</> : <>Wiggle이<br />다른 이유</>}</h2>
        <ul>
          {(studio ? STUDIO_STEPS : REASONS).map((reason) => (
            <li key={reason.title}>
              <img src={`/landing-gallery/icons/${reason.icon}.svg`} width={26} height={26} alt="" aria-hidden="true" loading="lazy" />
              <div>
                <b>{reason.title}</b>
                <span>{reason.body}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="landing-policy-links">
        <a href="/privacy">개인정보처리방침</a>
        <span aria-hidden="true">·</span>
        <a href="/terms">서비스 약관</a>
      </p>
    </main>
  );
}
