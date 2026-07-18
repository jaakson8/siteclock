#!/usr/bin/env python3
import argparse
import io
import json
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph, Table, TableStyle


def money(cents):
    return f"{cents / 100:,.2f}".replace(",", " ") + " EUR"


def make_pdf(invoice, output):
    language = invoice.get("language", "et")
    labels = {
        "et": ["Töömaa kohaloleku ja tööaja haldus", "ARVE", "ARVE ESITAJA", "ARVE SAAJA", "Registrikood", "Arve kuupäev", "Maksetähtaeg", "Viitenumber", "Kirjeldus", "Kogus", "Hind", "Summa", "SiteClocki teenus", "Vahesumma", "Käibemaks", "TASUDA KOKKU", "Makseinfo", "Selgitus: arve", "Täname õigeaegse tasumise eest.", "arve"],
        "fi": ["Työmaan läsnäolon ja työajan hallinta", "LASKU", "LASKUTTAJA", "LASKUN SAAJA", "Y-tunnus", "Laskun päiväys", "Eräpäivä", "Viitenumero", "Kuvaus", "Määrä", "Hinta", "Summa", "SiteClock-palvelu", "Välisumma", "Arvonlisävero", "MAKSETTAVA YHTEENSÄ", "Maksutiedot", "Viesti: lasku", "Kiitos oikea-aikaisesta maksusta.", "lasku"],
        "en": ["Site attendance and work-time management", "INVOICE", "SELLER", "CUSTOMER", "Registry code", "Invoice date", "Due date", "Reference", "Description", "Quantity", "Price", "Amount", "SiteClock service", "Subtotal", "VAT", "TOTAL DUE", "Payment details", "Message: invoice", "Thank you for your prompt payment.", "invoice"],
    }.get(language)
    canvas = Canvas(output, pagesize=A4)
    width, height = A4
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, width, height, fill=1, stroke=0)
    green = colors.HexColor("#173F35")
    muted = colors.HexColor("#64737B")
    border = colors.HexColor("#D9E0E3")
    styles = getSampleStyleSheet()
    normal = ParagraphStyle("normal", parent=styles["Normal"], fontName="Helvetica", fontSize=9.5, leading=14, textColor=colors.HexColor("#172126"))
    right = ParagraphStyle("right", parent=normal, alignment=TA_RIGHT)

    canvas.setFillColor(green)
    canvas.roundRect(20 * mm, height - 35 * mm, 15 * mm, 15 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 15)
    canvas.drawCentredString(27.5 * mm, height - 29.5 * mm, "S")
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 18)
    canvas.drawString(40 * mm, height - 25 * mm, "SITECLOCK")
    canvas.setFillColor(muted)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(40 * mm, height - 31 * mm, labels[0])

    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 25)
    canvas.drawRightString(width - 20 * mm, height - 24 * mm, labels[1])
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawRightString(width - 20 * mm, height - 31 * mm, invoice["number"])

    seller = invoice.get("seller", {})
    client = invoice.get("client", {})
    canvas.setStrokeColor(border)
    canvas.line(20 * mm, height - 43 * mm, width - 20 * mm, height - 43 * mm)
    canvas.setFillColor(muted)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(20 * mm, height - 52 * mm, labels[2])
    canvas.drawString(110 * mm, height - 52 * mm, labels[3])
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawString(20 * mm, height - 59 * mm, seller.get("name", "Objektiaeg OÜ"))
    canvas.drawString(110 * mm, height - 59 * mm, client.get("name", ""))
    canvas.setFont("Helvetica", 9)
    canvas.drawString(20 * mm, height - 65 * mm, f"{labels[4]}: {seller.get('registryCode', '')}")
    canvas.drawString(20 * mm, height - 70 * mm, seller.get("email", ""))
    canvas.drawString(110 * mm, height - 65 * mm, f"{labels[4]}: {client.get('registryCode', '')}")
    canvas.drawString(110 * mm, height - 70 * mm, client.get("email", ""))

    meta = [[Paragraph(f"<b>{labels[5]}</b>", normal), Paragraph(f"<b>{labels[6]}</b>", normal), Paragraph(f"<b>{labels[7]}</b>", normal)],
            [invoice["issuedDate"], invoice["dueDate"], invoice.get("reference", invoice["number"].replace("-", ""))]]
    table = Table(meta, colWidths=[56 * mm, 56 * mm, 56 * mm], rowHeights=[8 * mm, 10 * mm])
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF3F1")), ("BOX", (0, 0), (-1, -1), 0.7, border), ("INNERGRID", (0, 0), (-1, -1), 0.7, border), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
    table.wrapOn(canvas, width, height)
    table.drawOn(canvas, 20 * mm, height - 101 * mm)

    item_data = [[Paragraph(f"<b>{labels[8]}</b>", normal), Paragraph(f"<b>{labels[9]}</b>", right), Paragraph(f"<b>{labels[10]}</b>", right), Paragraph(f"<b>{labels[11]}</b>", right)]]
    item_data.append([invoice.get("description", f"{labels[12]} - {invoice.get('period', '')}"), "1", money(invoice["subtotalCents"]), money(invoice["subtotalCents"])])
    items = Table(item_data, colWidths=[93 * mm, 20 * mm, 27 * mm, 28 * mm], rowHeights=[10 * mm, 14 * mm])
    items.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), green), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("BOX", (0, 0), (-1, -1), 0.7, border), ("INNERGRID", (0, 0), (-1, -1), 0.7, border), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("ALIGN", (1, 1), (-1, -1), "RIGHT")]))
    items.wrapOn(canvas, width, height)
    items.drawOn(canvas, 20 * mm, height - 137 * mm)

    vat_percent = invoice.get("vatRate", 0.24) * 100
    totals = [[labels[13], money(invoice["subtotalCents"])], [f"{labels[14]} {vat_percent:g}%", money(invoice["vatCents"])], [Paragraph(f"<b>{labels[15]}</b>", normal), Paragraph(f"<b>{money(invoice['totalCents'])}</b>", right)]]
    total_table = Table(totals, colWidths=[38 * mm, 35 * mm], rowHeights=[8 * mm, 8 * mm, 11 * mm])
    total_table.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("LINEABOVE", (0, 2), (-1, 2), 1.2, green), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    total_table.wrapOn(canvas, width, height)
    total_table.drawOn(canvas, width - 93 * mm, height - 172 * mm)

    canvas.setFillColor(colors.HexColor("#EEF3F1"))
    canvas.roundRect(20 * mm, height - 205 * mm, 168 * mm, 22 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(26 * mm, height - 192 * mm, labels[16])
    canvas.setFont("Helvetica", 9)
    canvas.drawString(26 * mm, height - 198 * mm, f"IBAN: {seller.get('iban', '')}    {labels[17]} {invoice['number']}")

    canvas.setStrokeColor(border)
    canvas.line(20 * mm, 25 * mm, width - 20 * mm, 25 * mm)
    canvas.setFillColor(muted)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(20 * mm, 18 * mm, labels[18])
    canvas.drawRightString(width - 20 * mm, 18 * mm, f"SiteClock - {labels[19]} 1/1")
    canvas.save()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    invoice = json.load(open(args.input, encoding="utf-8")) if args.input else json.load(sys.stdin)
    if args.output:
        with open(args.output, "wb") as target:
            make_pdf(invoice, target)
    else:
        buffer = io.BytesIO()
        make_pdf(invoice, buffer)
        sys.stdout.buffer.write(buffer.getvalue())


if __name__ == "__main__":
    main()
