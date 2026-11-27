import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap empty">
      <h1 className="serif" style={{ fontSize: 44 }}>
        This piece has <em>left the rail</em>
      </h1>
      <p>It may have sold out or moved. Here is what is in now.</p>
      <Link className="btn dark" href="/shop?sort=new">
        Shop new in
      </Link>
    </div>
  );
}
