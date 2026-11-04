import { bookOrderSettings } from "@/lib/book-orders";
import { bookOrderSettingsReady, unitPriceFor, won } from "@/lib/book-order-pricing";
import { BOOK_PRINT_PRODUCTS, BOOK_PRINT_SPEC_UID } from "@/lib/book-print-format";

/**
 * 그림책 공방 첫 화면(2026-11-04). 꿈틀 그림책(book.kkumtle.app) 첫 화면처럼 상품 상세 모양이다.
 * 왼쪽 큰 그림은 제품 소개용 예시 그림이다(public/samples, 실제 학생 작품이 아니다).
 * 가격은 운영자가 운영 관리에서 정한 값(bookOrderSettings)을 그대로 보인다.
 */
const SAMPLES = [
  { src: "/samples/whale.jpg", title: "바다 친구 고래" },
  { src: "/samples/house.jpg", title: "우리 동네 빨간 집" },
  { src: "/samples/rocket.jpg", title: "우주로 가는 로켓" },
];
const WAYS = [
  { name: "사진·스캔", body: "아이들 그림을 찍거나 스캔한 사진을 여러 장 한 번에 올려요. 한 장이 한 쪽이 되고, 파일 이름 순서대로 들어가요." },
  { name: "완성 PDF", body: "이미 만든 그림책 PDF를 그대로 올려요. 첫 쪽이 앞표지, 끝쪽이 뒤표지예요. 한 파일에 300MB까지예요." },
  { name: "편집", body: "올린 뒤 편집기에서 쪽 순서를 바꾸고, 글을 쓰고, 표지를 꾸며요." },
];

async function loadSettings() {
  try { return await bookOrderSettings(); } catch { return null; }
}

export async function StudioLanding({ teacherAuthFailed }: { teacherAuthFailed: boolean }) {
  const settings = await loadSettings();
  const ready = bookOrderSettingsReady(settings) ? settings : null;
  const product = BOOK_PRINT_PRODUCTS[BOOK_PRINT_SPEC_UID];
  const tiers = [24, 32, 40, 48];
  return <main className="shop-main">
    <div className="shop-wrap">
      <p className="shop-crumb">홈 &gt; 그림책 인쇄 &gt; 하드커버 스퀘어북</p>
      {teacherAuthFailed && <aside className="shop-alert" role="alert">
        <b>구글 로그인이 되지 않았어요.</b> 학교 구글 계정은 학교 관리자가 외부 서비스 접속을 막아 둔 경우가 있어요. 개인 Gmail로 다시 시도하거나, 학교 관리자에게 이 서비스 허용을 요청해 주세요.
        <a className="shop-btn line" href="/api/auth/google/start?return_to=%2Fteacher">다른 계정으로 다시 로그인</a>
      </aside>}
      <section className="shop-product">
        <div className="shop-gallery">
          <div className="shop-gallery-main"><div className="shop-mock-book"><img src={SAMPLES[0].src} alt="크레용으로 그린 고래 그림책 표지 예시" /><div><b>{SAMPLES[0].title}</b><small>예시 그림책 · 꿈틀 그림책</small></div></div></div>
          <ul className="shop-thumbs">{SAMPLES.map((sample) => <li key={sample.src}><img src={sample.src} alt={`${sample.title} 예시`} loading="lazy" /></li>)}</ul>
        </div>
        <div className="shop-info">
          <p className="shop-badges"><span className="solid">학교 단체 주문</span><span>1권부터 제작</span></p>
          <h1>그림책 하드커버 스퀘어북</h1>
          <p className="shop-lead">아이들 그림 사진·스캔이나 완성 PDF를 올려 편집하고, 하드커버 책으로 인쇄해 학교로 보내 드려요.</p>
          <p className="shop-price">{ready ? <><b className="num">{won(ready.basePrice)}~</b><span>표지 포함 {product.pageMin}쪽 기준 · {ready.vatIncluded ? "부가세 포함" : "부가세 별도"}</span></> : <span>가격은 주문 화면에서 바로 확인할 수 있어요.</span>}</p>
          <div className="shop-option"><div className="shop-option-head"><b>크기</b><span>{product.trimWidthMm} × {product.trimHeightMm} mm</span></div><span className="shop-chip is-on">스퀘어 {product.trimWidthMm}×{product.trimHeightMm}</span></div>
          {ready && <div className="shop-option"><div className="shop-option-head"><b>쪽 수별 권당 가격</b><span>책을 올리면 쪽 수에 맞춰 정해져요</span></div>
            <ul className="shop-tiers">{tiers.map((pages) => <li key={pages}><b>{pages}쪽</b><span className="num">{won(unitPriceFor(pages, ready))}</span></li>)}</ul></div>}
          <a className="shop-btn solid big" href="/teacher">그림책 만들기 시작</a>
          <div className="shop-btn-row"><a className="shop-btn line big" href="#shop-notice">상품정보 보기</a><a className="shop-btn line big" href="#shop-how">만드는 방법</a></div>
          <div className="shop-box"><b>학교에서 구매하시나요?</b><p>주문하면 견적서가 바로 나와 학교 결재에 붙일 수 있어요. 계좌 입금이나 카드(학교 구매카드 포함)·계좌이체·간편결제로 결제해요.</p></div>
        </div>
      </section>
      <section className="shop-section" id="shop-notice" aria-labelledby="shop-notice-title"><h2 id="shop-notice-title">상품정보 제공고시</h2>
        <table className="shop-table"><tbody>
          <tr><th>품명</th><td>그림책 하드커버 스퀘어북 (주문 제작)</td></tr>
          <tr><th>크기 · 제본</th><td>{product.trimWidthMm} × {product.trimHeightMm} mm · PUR 무선제본, 하드커버</td></tr>
          <tr><th>쪽 수</th><td>속지 {product.pageMin}쪽부터 {product.pageMax}쪽까지, {product.pageIncrement}쪽 단위. 모자란 쪽은 뒤에 흰 쪽으로 채워요.</td></tr>
          <tr><th>배송</th><td>학교 한 곳으로 묶음 배송{ready ? `, 주문 한 건에 ${won(ready.shippingFee)}${ready.freeShippingQuantity > 0 ? ` (${ready.freeShippingQuantity}권 이상 무료)` : ""}` : ""}</td></tr>
          <tr><th>청약철회</th><td>주문 제작 상품이라 인쇄를 시작한 뒤에는 단순 변심으로 취소·반품할 수 없어요. 입금·결제 전에는 언제든 취소할 수 있어요.</td></tr>
        </tbody></table>
      </section>
      <section className="shop-section" id="shop-how" aria-labelledby="shop-how-title"><h2 id="shop-how-title">그림책 만드는 방법</h2>
        <table className="shop-table"><tbody>{WAYS.map((way) => <tr key={way.name}><th>{way.name}</th><td>{way.body}</td></tr>)}
          <tr><th>주문·결제</th><td>책과 권수, 배송지를 고르면 견적서가 바로 나와요. 결제가 확인되면 제작해 보내 드려요.</td></tr>
        </tbody></table>
      </section>
    </div>
  </main>;
}
