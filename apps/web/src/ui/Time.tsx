// A moment the server gave, shown in the owner's own zone with the exact
// UTC time one hover or one focus away. Never computed by the page.
const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Time(props: { at: string | null; none?: string }) {
  if (props.at === null) return <span className="muted">{props.none ?? "never"}</span>;
  const moment = new Date(props.at);
  if (Number.isNaN(moment.getTime())) return <span>{props.at}</span>;
  return (
    <time dateTime={props.at} title={`${moment.toISOString()} (UTC)`}>
      {format.format(moment)}
    </time>
  );
}
