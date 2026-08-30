"""Generate malformed / adversarial / large inputs for robustness benchmarks.

Ferret indexes untrusted repository content (Governance 12). A parser's
behaviour on hostile or corrupt input is a selection criterion, not an
afterthought. Every file here is derived deterministically from the healthy
corpus so both runtimes face identical bytes.
"""
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "corpus"
OUT = CORPUS / "malformed"
LARGE = CORPUS / "large"


def truncate(src: Path, dst: Path, frac: float):
    data = src.read_bytes()
    dst.write_bytes(data[: max(1, int(len(data) * frac))])


def corrupt_middle(src: Path, dst: Path):
    data = bytearray(src.read_bytes())
    for i in range(len(data) // 3, min(len(data), len(data) // 3 + 4096)):
        data[i] ^= 0xFF
    dst.write_bytes(bytes(data))


def zip_bomb_ish(dst: Path):
    """Highly compressible OOXML-shaped archive: decompression amplification."""
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("word/document.xml", "<w:p>" + ("A" * 40_000_000) + "</w:p>")


def xxe_docx(dst: Path):
    """OOXML carrying an external-entity declaration (XXE probe)."""
    doc = ('<?xml version="1.0"?>'
           '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>')
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                   '</Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                   '</Relationships>')
        z.writestr("word/document.xml", doc)


def main():
    if not (CORPUS / "CORPUS.json").exists():
        print("healthy corpus missing; run gen_corpus.py first", file=sys.stderr)
        return 1
    for d in (OUT, LARGE):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    docs = CORPUS / "docs"
    cases = []

    for kind, name in (("pdf", "doc_0.pdf"), ("docx", "spec_0.docx"),
                       ("xlsx", "book_0.xlsx"), ("csv", "table_0.csv")):
        src = docs / name
        for label, fn in (("truncated50", lambda s, d: truncate(s, d, 0.5)),
                          ("truncated05", lambda s, d: truncate(s, d, 0.05)),
                          ("corrupt", corrupt_middle)):
            dst = OUT / f"{kind}_{label}.{kind}"
            fn(src, dst)
            cases.append({"kind": kind, "case": label, "file": dst.name,
                          "bytes": dst.stat().st_size})

    empty = OUT / "pdf_empty.pdf"
    empty.write_bytes(b"")
    cases.append({"kind": "pdf", "case": "empty", "file": empty.name, "bytes": 0})

    wrong = OUT / "pdf_wrongtype.pdf"
    shutil.copyfile(docs / "book_0.xlsx", wrong)
    cases.append({"kind": "pdf", "case": "wrong_magic", "file": wrong.name,
                  "bytes": wrong.stat().st_size})

    bomb = OUT / "docx_amplification.docx"
    zip_bomb_ish(bomb)
    cases.append({"kind": "docx", "case": "decompression_amplification",
                  "file": bomb.name, "bytes": bomb.stat().st_size,
                  "uncompressed_bytes": 40_000_000})

    xxe = OUT / "docx_xxe.docx"
    xxe_docx(xxe)
    cases.append({"kind": "docx", "case": "xxe_external_entity", "file": xxe.name,
                  "bytes": xxe.stat().st_size})

    # Large-file inputs: single-file scale behaviour, not corpus throughput.
    big_csv = LARGE / "large.csv"
    with big_csv.open("w", newline="", encoding="utf-8") as fh:
        fh.write("id,name,amount,note\n")
        for r in range(2_000_000):
            fh.write(f"{r},name{r},{r % 100000 / 100.0},row note {r}\n")
    large = [{"kind": "csv", "file": big_csv.name, "bytes": big_csv.stat().st_size,
              "rows": 2_000_000}]

    manifest = {"malformed": cases, "large": large}
    (OUT / "MALFORMED.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"status": "generated", "malformed_cases": len(cases),
                      "large_files": len(large),
                      "large_bytes": big_csv.stat().st_size}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
