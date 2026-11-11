/** Why a view shows less detail than it asks for, when the views share too little memory. */
export function coverageMessage(wanted: number, short: number): string {
  return `This view shows less detail: ${short.toLocaleString()} of the ${wanted.toLocaleString()} ` +
    `chunks it needs don't fit in the memory the views share.`;
}
