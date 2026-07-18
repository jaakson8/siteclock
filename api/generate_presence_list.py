import json
import sys
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


data = json.load(sys.stdin)
buffer = BytesIO()
doc = SimpleDocTemplate(
    buffer,
    pagesize=A4,
    rightMargin=16 * mm,
    leftMargin=16 * mm,
    topMargin=15 * mm,
    bottomMargin=15 * mm,
    title=f"Kohalolijate nimekiri - {data['siteName']}",
)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Meta", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#52625C"), leading=13))
styles.add(ParagraphStyle(name="Cell", parent=styles["Normal"], fontSize=8.5, leading=11))
story = [
    Paragraph("OBJEKTIAEG", ParagraphStyle(name="Brand", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#17614E"), spaceAfter=5)),
    Paragraph("Evakuatsiooni- ja kohalolijate nimekiri", styles["Title"]),
    Spacer(1, 4 * mm),
    Paragraph(f"<b>Töömaa:</b> {data['siteName']}", styles["Normal"]),
    Paragraph(f"<b>Aadress:</b> {data.get('address') or '-'}", styles["Normal"]),
    Paragraph(f"<b>Koostatud:</b> {data['generatedAt']}", styles["Meta"]),
    Paragraph("Nimekiri põhineb viimastel IN/OUT registreeringutel. Hädaolukorras kontrolli kohalolekut füüsiliselt.", styles["Meta"]),
    Spacer(1, 5 * mm),
]

rows = [["#", "Nimi", "Telefon", "Saabus", "Kohal olnud", "Kontroll"]]
for index, person in enumerate(data["people"], 1):
    duration = f"{person['durationMinutes'] // 60} h {person['durationMinutes'] % 60} min"
    rows.append([
        str(index),
        Paragraph(person["workerName"], styles["Cell"]),
        Paragraph(person.get("phone") or "-", styles["Cell"]),
        person["time"],
        duration,
        "[   ]",
    ])
if not data["people"]:
    rows.append(["", Paragraph("Hetkel ei ole kedagi töömaale registreeritud.", styles["Cell"]), "", "", "", ""])

table = Table(rows, colWidths=[9 * mm, 51 * mm, 37 * mm, 23 * mm, 31 * mm, 25 * mm], repeatRows=1)
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173F35")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, 0), 8.5),
    ("ALIGN", (0, 0), (0, -1), "CENTER"),
    ("ALIGN", (3, 1), (-1, -1), "CENTER"),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD8D3")),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F7F5")]),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.extend([table, Spacer(1, 6 * mm), Paragraph(f"Kokku kohal: <b>{len(data['people'])}</b>", styles["Normal"]), Spacer(1, 8 * mm), Paragraph("Vastutava isiku nimi ja allkiri: ______________________________________________", styles["Normal"])])


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#6B7974"))
    canvas.drawString(16 * mm, 9 * mm, "SiteClock - kohalolijate nimekiri")
    canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, f"Lehekülg {document.page}")
    canvas.restoreState()


doc.build(story, onFirstPage=footer, onLaterPages=footer)
sys.stdout.buffer.write(buffer.getvalue())
