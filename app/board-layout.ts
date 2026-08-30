export type BoardPoint = { x: number; y: number };
export type BoardQuad = [BoardPoint, BoardPoint, BoardPoint, BoardPoint];

export type BoardLayoutNote = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
};

export type QuadLayerProposal = {
  cluster: number;
  corners: BoardQuad;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(left: BoardPoint, right: BoardPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Converts a detected source-image quad into an editable, rotated CSS rectangle. */
export function quadToBoardGeometry(quad: BoardQuad, sourceWidth: number, sourceHeight: number) {
  const topWidth = distance(quad[0], quad[1]);
  const bottomWidth = distance(quad[3], quad[2]);
  const leftHeight = distance(quad[0], quad[3]);
  const rightHeight = distance(quad[1], quad[2]);
  const width = clamp(((topWidth + bottomWidth) / 2 / Math.max(1, sourceWidth)) * 100, 0.6, 100);
  const height = clamp(((leftHeight + rightHeight) / 2 / Math.max(1, sourceHeight)) * 100, 0.6, 100);
  const centerX = quad.reduce((sum, point) => sum + point.x, 0) / quad.length / Math.max(1, sourceWidth) * 100;
  const centerY = quad.reduce((sum, point) => sum + point.y, 0) / quad.length / Math.max(1, sourceHeight) * 100;
  const rotation = Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x) * 180 / Math.PI;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: Math.abs(rotation) < 0.08 ? 0 : rotation,
  };
}

function pointInsideQuad(x: number, y: number, quad: BoardQuad) {
  let sign = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index];
    const next = quad[(index + 1) % quad.length];
    const cross = (next.x - current.x) * (y - current.y) - (next.y - current.y) * (x - current.x);
    if (Math.abs(cross) < 1e-5) continue;
    const currentSign = Math.sign(cross);
    if (!sign) sign = currentSign;
    else if (currentSign !== sign) return false;
  }
  return true;
}

/**
 * Infers a stable bottom-to-top order. In a shared image area the colour that
 * is still visible belongs to the paper lying on top.
 */
export function inferOverlapLayerOrder(
  proposals: QuadLayerProposal[],
  labels: Uint8Array,
  maskWidth: number,
  maskHeight: number,
) {
  const scores = new Int16Array(proposals.length);
  for (let leftIndex = 0; leftIndex < proposals.length; leftIndex += 1) {
    const left = proposals[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < proposals.length; rightIndex += 1) {
      const right = proposals[rightIndex];
      if (left.cluster === right.cluster) continue;
      const minimumX = Math.max(0, Math.floor(Math.max(
        Math.min(...left.corners.map((point) => point.x)),
        Math.min(...right.corners.map((point) => point.x)),
      )));
      const maximumX = Math.min(maskWidth - 1, Math.ceil(Math.min(
        Math.max(...left.corners.map((point) => point.x)),
        Math.max(...right.corners.map((point) => point.x)),
      )));
      const minimumY = Math.max(0, Math.floor(Math.max(
        Math.min(...left.corners.map((point) => point.y)),
        Math.min(...right.corners.map((point) => point.y)),
      )));
      const maximumY = Math.min(maskHeight - 1, Math.ceil(Math.min(
        Math.max(...left.corners.map((point) => point.y)),
        Math.max(...right.corners.map((point) => point.y)),
      )));
      if (minimumX > maximumX || minimumY > maximumY) continue;

      let leftPixels = 0;
      let rightPixels = 0;
      let sharedPixels = 0;
      const stride = Math.max(1, Math.floor(Math.sqrt((maximumX - minimumX + 1) * (maximumY - minimumY + 1)) / 54));
      for (let y = minimumY; y <= maximumY; y += stride) {
        for (let x = minimumX; x <= maximumX; x += stride) {
          if (!pointInsideQuad(x + 0.5, y + 0.5, left.corners)
            || !pointInsideQuad(x + 0.5, y + 0.5, right.corners)) continue;
          sharedPixels += 1;
          const label = labels[y * maskWidth + x];
          if (label === left.cluster) leftPixels += 1;
          if (label === right.cluster) rightPixels += 1;
        }
      }
      if (sharedPixels < 6 || leftPixels + rightPixels < 4) continue;
      if (leftPixels >= Math.max(3, rightPixels * 1.22)) {
        scores[leftIndex] += 1;
        scores[rightIndex] -= 1;
      } else if (rightPixels >= Math.max(3, leftPixels * 1.22)) {
        scores[rightIndex] += 1;
        scores[leftIndex] -= 1;
      }
    }
  }

  const bottomToTop = proposals.map((_, index) => index)
    .sort((left, right) => scores[left] - scores[right] || left - right);
  const order = new Uint8Array(proposals.length);
  bottomToTop.forEach((proposalIndex, layer) => { order[proposalIndex] = layer; });
  return [...order];
}

function readingOrder<T extends BoardLayoutNote>(notes: T[]) {
  if (notes.length < 2) return [...notes];
  const rowTolerance = Math.max(2.5, median(notes.map((note) => note.height)) * 0.52);
  const byY = [...notes].sort((left, right) => (left.y + left.height / 2) - (right.y + right.height / 2)
    || (left.x + left.width / 2) - (right.x + right.width / 2));
  const rows: Array<{ centerY: number; notes: T[] }> = [];
  for (const note of byY) {
    const centerY = note.y + note.height / 2;
    const row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= rowTolerance);
    if (row) {
      row.notes.push(note);
      row.centerY = row.notes.reduce((sum, entry) => sum + entry.y + entry.height / 2, 0) / row.notes.length;
    } else rows.push({ centerY, notes: [note] });
  }
  return rows.sort((left, right) => left.centerY - right.centerY)
    .flatMap((row) => row.notes.sort((left, right) => (left.x + left.width / 2) - (right.x + right.width / 2)));
}

/** Produces a non-destructive, straight and collision-free reading view. */
export function createTidyLayout<T extends BoardLayoutNote>(notes: T[], boardAspectRatio: number): T[] {
  if (!notes.length) return [];
  const aspectRatio = clamp(boardAspectRatio || 1.6, 0.5, 3);
  const marginX = 3;
  const marginY = 4;
  const gapX = 1.5;
  const gapY = 2;
  let best = { columns: 1, rows: notes.length, cellWidth: 94, cellHeight: 1, noteWidth: 1, noteHeight: aspectRatio };
  for (let columns = 1; columns <= Math.min(notes.length, 10); columns += 1) {
    const rows = Math.ceil(notes.length / columns);
    const cellWidth = (100 - marginX * 2 - gapX * (columns - 1)) / columns;
    const cellHeight = (100 - marginY * 2 - gapY * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const noteWidth = Math.min(22, cellWidth * 0.9, cellHeight * 0.9 / aspectRatio);
    const noteHeight = noteWidth * aspectRatio;
    if (noteWidth > best.noteWidth) best = { columns, rows, cellWidth, cellHeight, noteWidth, noteHeight };
  }

  return readingOrder(notes).map((note, index) => {
    const column = index % best.columns;
    const row = Math.floor(index / best.columns);
    const x = marginX + column * (best.cellWidth + gapX) + (best.cellWidth - best.noteWidth) / 2;
    const y = marginY + row * (best.cellHeight + gapY) + (best.cellHeight - best.noteHeight) / 2;
    return {
      ...note,
      x,
      y,
      width: best.noteWidth,
      height: best.noteHeight,
      rotation: 0,
      zIndex: index + 2,
    };
  });
}
