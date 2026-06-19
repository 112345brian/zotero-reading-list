// Back-matter section patterns matched against the start of outline item titles
const BACK_MATTER_PATTERNS =
	/^(appendix|appendices|references?|bibliography|bibliographies|index|indices|notes|endnotes|glossary|acknowledgements?|about the author|colophon)/i;

export interface ReadProgress {
	highwaterPage: number; // 1-indexed, matches pdf.js `page` property
	totalPages: number;
}

export function parseProgress(progressStr: string): ReadProgress | null {
	const match = /^(\d+)\/(\d+)$/.exec(progressStr);
	if (!match) return null;
	const hwm = parseInt(match[1], 10);
	const total = parseInt(match[2], 10);
	if (isNaN(hwm) || isNaN(total) || total <= 0) return null;
	return { highwaterPage: hwm, totalPages: total };
}

export function formatProgress(
	highwaterPage: number,
	totalPages: number,
): string {
	return `${highwaterPage}/${totalPages}`;
}

/**
 * Scan the PDF outline for back-matter sections (references, appendix, etc.)
 * starting in the final 30% of the document. Returns the 1-indexed page where
 * back matter begins, or null if none found (fall back to threshold).
 */
export async function detectContentEndPage(
	pdfApp: _ZoteroTypes.Reader.PDFViewerApplication,
): Promise<number | null> {
	try {
		const pdfDocument = pdfApp.pdfDocument;
		const totalPages = pdfApp.pagesCount;
		if (!pdfDocument || !totalPages) return null;

		const outline = await pdfDocument.getOutline();
		if (!outline || outline.length === 0) return null;

		// Only count back matter that starts in the last 30% of pages
		const thresholdZeroIndexed = Math.floor(totalPages * 0.7);

		const searchOutline = async (
			items: Awaited<ReturnType<typeof pdfDocument.getOutline>>,
		): Promise<number | null> => {
			for (const item of items) {
				if (BACK_MATTER_PATTERNS.test((item.title ?? "").trim())) {
					const pageZeroIndexed = await resolveDestPageIndex(
						pdfDocument,
						item.dest,
					);
					if (
						pageZeroIndexed !== null &&
						pageZeroIndexed >= thresholdZeroIndexed
					) {
						return pageZeroIndexed + 1; // convert to 1-indexed
					}
				}
				if (item.items?.length) {
					const childResult = await searchOutline(item.items);
					if (childResult !== null) return childResult;
				}
			}
			return null;
		};

		return await searchOutline(outline);
	} catch {
		return null;
	}
}

async function resolveDestPageIndex(
	pdfDocument: _ZoteroTypes.Reader.PDFDocumentProxy,
	dest: string | Array<any> | null,
): Promise<number | null> {
	if (dest === null) return null;
	try {
		const explicitDest =
			typeof dest === "string"
				? await pdfDocument.getDestination(dest)
				: dest;
		if (!explicitDest || !explicitDest[0]) return null;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		return await pdfDocument.getPageIndex(explicitDest[0]);
	} catch {
		return null;
	}
}
