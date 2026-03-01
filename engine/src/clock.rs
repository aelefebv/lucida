use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub(crate) fn rfc3339_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("rfc3339 formatting should not fail for utc timestamps")
}
