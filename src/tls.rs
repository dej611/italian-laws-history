//! TLS setup that still verifies against the webpki root store, but fills in
//! intermediates the server forgot to send.
//!
//! `api.normattiva.it` (cert issued 2026-10-01) presents only its leaf.
//! rustls does not follow the AIA CA Issuers URL, so the handshake dies with
//! `UnknownIssuer` before any HTTP response. Browsers and macOS Secure
//! Transport download that missing certificate; this verifier does the same,
//! then runs the normal webpki path check.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, Error, RootCertStore, SignatureScheme,
    StreamOwned,
};
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::FromDer;

const AIA_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CERT_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = MAX_CERT_BYTES + 8 * 1024;
const MAX_AIA_DEPTH: usize = 4;
const CA_ISSUERS_OID: &str = "1.3.6.1.5.5.7.48.2";

pub fn client_config() -> anyhow::Result<ClientConfig> {
    let provider = rustls::crypto::ring::default_provider();
    // reqwest installs ring itself when no default is set. Installing first
    // keeps both configs on the same provider; a second install is ignored.
    let _ = provider.clone().install_default();
    let provider = Arc::new(provider);

    let roots = Arc::new(root_store());
    let inner =
        WebPkiServerVerifier::builder_with_provider(Arc::clone(&roots), Arc::clone(&provider))
            .build()
            .map_err(|e| anyhow::anyhow!("TLS verifier: {e}"))?;

    let verifier = Arc::new(AiaVerifier {
        inner,
        https: Arc::new(plain_config(Arc::clone(&provider), Arc::clone(&roots))?),
        cache: Mutex::new(HashMap::new()),
    });

    let mut tls = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow::anyhow!("TLS versions: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    // reqwest is built without the http2 feature, so advertise only HTTP/1.1.
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(tls)
}

fn root_store() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots
        .roots
        .extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
}

fn plain_config(
    provider: Arc<rustls::crypto::CryptoProvider>,
    roots: Arc<RootCertStore>,
) -> anyhow::Result<ClientConfig> {
    let mut tls = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow::anyhow!("TLS versions: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(tls)
}

struct AiaVerifier {
    inner: Arc<WebPkiServerVerifier>,
    https: Arc<ClientConfig>,
    cache: Mutex<HashMap<String, Vec<CertificateDer<'static>>>>,
}

impl std::fmt::Debug for AiaVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiaVerifier").finish_non_exhaustive()
    }
}

impl ServerCertVerifier for AiaVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let mut extra: Vec<CertificateDer<'static>> = Vec::new();
        let mut fetched: HashSet<String> = HashSet::new();
        let mut unknown = None;

        for _ in 0..MAX_AIA_DEPTH {
            let mut chain: Vec<CertificateDer<'_>> = intermediates.to_vec();
            chain.extend(extra.iter().map(|c| c.as_ref().into()));
            match self
                .inner
                .verify_server_cert(end_entity, &chain, server_name, ocsp_response, now)
            {
                Ok(verified) => return Ok(verified),
                Err(err) if is_unknown_issuer(&err) => unknown = Some(err),
                Err(err) => return Err(err),
            }

            let mut urls = ca_issuer_urls(end_entity.as_ref());
            for cert in intermediates.iter().chain(extra.iter()) {
                urls.extend(ca_issuer_urls(cert.as_ref()));
            }
            let mut progressed = false;
            for url in urls {
                if !fetched.insert(url.clone()) {
                    continue;
                }
                let Some(certs) = self.load_or_fetch(&url) else {
                    continue;
                };
                for cert in certs {
                    if chain_contains(cert.as_ref(), end_entity, intermediates, &extra) {
                        continue;
                    }
                    extra.push(cert);
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        Err(unknown
            .unwrap_or_else(|| Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn root_hint_subjects(&self) -> Option<&[rustls::DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}

fn is_unknown_issuer(err: &Error) -> bool {
    matches!(
        err,
        Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
    )
}

fn chain_contains(
    der: &[u8],
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    extra: &[CertificateDer<'static>],
) -> bool {
    end_entity.as_ref() == der
        || intermediates.iter().any(|c| c.as_ref() == der)
        || extra.iter().any(|c| c.as_ref() == der)
}

impl AiaVerifier {
    fn load_or_fetch(&self, url: &str) -> Option<Vec<CertificateDer<'static>>> {
        if let Some(hit) = self
            .cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(url)
            .cloned()
        {
            return Some(hit);
        }
        let https = Arc::clone(&self.https);
        let url_owned = url.to_string();
        let fetched = std::thread::scope(|scope| {
            scope
                .spawn(move || download_certs(&url_owned, &https))
                .join()
                .ok()
                .flatten()
        })?;
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(url.to_string(), fetched.clone());
        tracing::info!(%url, certs = fetched.len(), "fetched missing TLS intermediate");
        Some(fetched)
    }
}

fn ca_issuer_urls(der: &[u8]) -> Vec<String> {
    let Ok((_, cert)) = X509Certificate::from_der(der) else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for ext in cert.extensions() {
        let ParsedExtension::AuthorityInfoAccess(aia) = ext.parsed_extension() else {
            continue;
        };
        for desc in &aia.accessdescs {
            if desc.access_method.to_id_string() != CA_ISSUERS_OID {
                continue;
            }
            if let GeneralName::URI(uri) = &desc.access_location {
                urls.push((*uri).to_string());
            }
        }
    }
    urls
}

fn download_certs(start: &str, https: &ClientConfig) -> Option<Vec<CertificateDer<'static>>> {
    let mut current = start.to_string();
    for _ in 0..MAX_AIA_DEPTH {
        let parsed = url::Url::parse(&current).ok()?;
        if !aia_url_allowed(&parsed) {
            tracing::warn!(url = %current, "refusing AIA URL");
            return None;
        }
        let message = http_get(&parsed, https).ok()?;
        if (300..400).contains(&message.status) {
            let loc = message.location?;
            current = parsed.join(&loc).ok()?.to_string();
            continue;
        }
        let certs = decode_certs(&message.body);
        if certs.is_empty() {
            return None;
        }
        return Some(certs);
    }
    None
}

fn aia_url_allowed(url: &url::Url) -> bool {
    let port_ok = match url.scheme() {
        "http" => url.port_or_known_default() == Some(80),
        "https" => url.port_or_known_default() == Some(443),
        _ => false,
    };
    port_ok && url.username().is_empty() && url.password().is_none() && host_is_public_dns(url)
}

fn host_is_public_dns(url: &url::Url) -> bool {
    let Some(url::Host::Domain(host)) = url.host() else {
        return false;
    };
    if host.is_empty()
        || !host.contains('.')
        || host.ends_with('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok()
    {
        return false;
    }
    true
}

fn public_ip(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    };
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // Carrier-grade NAT, 100.64.0.0/10.
            let cgnat = o[0] == 100 && (o[1] & 0xc0) == 64;
            !cgnat
                && o[0] != 0
                && !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_unspecified()
                && !v4.is_multicast()
                && !v4.is_documentation()
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            let unique_local = first & 0xfe00 == 0xfc00;
            let link_local = first & 0xffc0 == 0xfe80;
            !v6.is_loopback()
                && !v6.is_unspecified()
                && !v6.is_multicast()
                && !unique_local
                && !link_local
        }
    }
}

struct HttpMessage {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

fn http_get(url: &url::Url, https: &ClientConfig) -> io::Result<HttpMessage> {
    let host = url
        .host_str()
        .ok_or_else(|| invalid("AIA URL has no host"))?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid("AIA URL has no port"))?;
    let tcp = connect_public(&host, port)?;
    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => {
            let p = url.path();
            if p.is_empty() {
                "/".to_string()
            } else {
                p.to_string()
            }
        }
    };
    let host_header = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );

    if url.scheme() == "https" {
        let name = ServerName::try_from(host).map_err(|_| invalid("AIA SNI"))?;
        let conn = ClientConnection::new(Arc::new(https.clone()), name)
            .map_err(|e| io::Error::other(e))?;
        let mut tls = StreamOwned::new(conn, tcp);
        tls.write_all(request.as_bytes())?;
        read_http(&mut tls)
    } else {
        let mut tcp = tcp;
        tcp.write_all(request.as_bytes())?;
        read_http(&mut tcp)
    }
}

fn connect_public(host: &str, port: u16) -> io::Result<TcpStream> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()?
        .filter(|addr| public_ip(addr.ip()))
        .collect();
    if addrs.is_empty() {
        return Err(invalid("AIA host did not resolve to a public address"));
    }
    let mut last = invalid("AIA connect failed");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, AIA_TIMEOUT) {
            Ok(stream) => {
                stream.set_read_timeout(Some(AIA_TIMEOUT))?;
                stream.set_write_timeout(Some(AIA_TIMEOUT))?;
                return Ok(stream);
            }
            Err(err) => last = err,
        }
    }
    Err(last)
}

fn read_http(stream: &mut impl Read) -> io::Result<HttpMessage> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        if let Some(message) = try_parse_http(&buf)? {
            return Ok(message);
        }
        if buf.len() > MAX_MESSAGE_BYTES {
            return Err(invalid("AIA response too large"));
        }
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return finish_on_close(&buf);
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn finish_on_close(buf: &[u8]) -> io::Result<HttpMessage> {
    if let Some(message) = try_parse_http(buf)? {
        return Ok(message);
    }
    let Some(header_end) = find_double_crlf(buf) else {
        return Err(invalid("truncated AIA response"));
    };
    let meta = parse_headers(&buf[..header_end])?;
    if !(200..300).contains(&meta.status) {
        return Err(invalid(format!("AIA HTTP {}", meta.status)));
    }
    if meta.chunked || meta.content_length.is_some() {
        return Err(invalid("truncated AIA body"));
    }
    let body = buf[header_end + 4..].to_vec();
    if body.len() > MAX_CERT_BYTES {
        return Err(invalid("AIA body too large"));
    }
    Ok(HttpMessage {
        status: meta.status,
        location: meta.location,
        body,
    })
}

struct HeaderMeta {
    status: u16,
    content_length: Option<usize>,
    chunked: bool,
    location: Option<String>,
}

fn try_parse_http(buf: &[u8]) -> io::Result<Option<HttpMessage>> {
    let Some(header_end) = find_double_crlf(buf) else {
        return Ok(None);
    };
    let meta = parse_headers(&buf[..header_end])?;
    if (300..400).contains(&meta.status) {
        return Ok(Some(HttpMessage {
            status: meta.status,
            location: meta.location,
            body: Vec::new(),
        }));
    }
    if !(200..300).contains(&meta.status) {
        return Err(invalid(format!("AIA HTTP {}", meta.status)));
    }
    let body_at = header_end + 4;
    if meta.chunked {
        let Some(body) = decode_chunked(&buf[body_at..]) else {
            return Ok(None);
        };
        if body.len() > MAX_CERT_BYTES {
            return Err(invalid("AIA body too large"));
        }
        return Ok(Some(HttpMessage {
            status: meta.status,
            location: None,
            body,
        }));
    }
    if let Some(len) = meta.content_length {
        if len > MAX_CERT_BYTES {
            return Err(invalid("AIA body too large"));
        }
        if buf.len() < body_at + len {
            return Ok(None);
        }
        return Ok(Some(HttpMessage {
            status: meta.status,
            location: None,
            body: buf[body_at..body_at + len].to_vec(),
        }));
    }
    Ok(None)
}

fn parse_headers(header_bytes: &[u8]) -> io::Result<HeaderMeta> {
    let header_text =
        std::str::from_utf8(header_bytes).map_err(|_| invalid("AIA headers are not UTF-8"))?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("bad AIA status line"))?;
    let mut content_length = None;
    let mut chunked = false;
    let mut location = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(
                value
                    .parse()
                    .map_err(|_| invalid("bad AIA content-length"))?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        } else if name.eq_ignore_ascii_case("location") {
            location = Some(value.to_string());
        }
    }
    Ok(HeaderMeta {
        status,
        content_length,
        chunked,
        location,
    })
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn decode_chunked(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let line = std::str::from_utf8(rest.get(..line_end)?).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        rest = rest.get(line_end + 2..)?;
        if size == 0 {
            return Some(out);
        }
        if out.len().saturating_add(size) > MAX_CERT_BYTES {
            return None;
        }
        let chunk = rest.get(..size)?;
        out.extend_from_slice(chunk);
        rest = rest.get(size..)?;
        if !rest.starts_with(b"\r\n") {
            return None;
        }
        rest = &rest[2..];
    }
}

fn decode_certs(body: &[u8]) -> Vec<CertificateDer<'static>> {
    let pem = body.windows(15).any(|w| w == b"-----BEGIN CERT");
    if pem {
        return CertificateDer::pem_slice_iter(body)
            .filter_map(Result::ok)
            .map(|c| c.into_owned())
            .collect();
    }
    if body.first() == Some(&0x30) {
        vec![CertificateDer::from(body.to_vec())]
    } else {
        Vec::new()
    }
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normattiva_leaf_names_globalsign_issuer() {
        let der = CertificateDer::from_pem_slice(include_bytes!(
            "../tests/fixtures/api-normattiva-leaf.pem"
        ))
        .unwrap();
        assert_eq!(
            ca_issuer_urls(der.as_ref()),
            vec!["http://secure.globalsign.com/cacert/gsgccr46ovtlsca2025.crt".to_string()]
        );
    }

    #[test]
    fn aia_url_policy() {
        let allow = |s: &str| aia_url_allowed(&url::Url::parse(s).unwrap());
        assert!(allow(
            "http://secure.globalsign.com/cacert/gsgccr46ovtlsca2025.crt"
        ));
        assert!(allow("https://secure.globalsign.com/cacert/x.crt"));
        assert!(!allow("http://127.0.0.1/cacert.crt"));
        assert!(!allow("http://localhost/cacert.crt"));
        assert!(!allow("http://ca.local/cacert.crt"));
        assert!(!allow("ftp://secure.globalsign.com/cacert.crt"));
        assert!(!allow("http://user:pw@secure.globalsign.com/cacert.crt"));
        assert!(!allow("http://secure.globalsign.com:8080/cacert.crt"));
    }

    #[test]
    fn public_ip_rejects_non_routable() {
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(!public_ip("127.0.0.1".parse().unwrap()));
        assert!(!public_ip("10.1.2.3".parse().unwrap()));
        assert!(!public_ip("192.168.1.1".parse().unwrap()));
        assert!(!public_ip("100.64.1.1".parse().unwrap()));
        assert!(!public_ip("169.254.1.1".parse().unwrap()));
        assert!(!public_ip("::1".parse().unwrap()));
    }

    #[tokio::test]
    #[ignore = "talks to api.normattiva.it"]
    async fn normattiva_search_with_incomplete_chain() {
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(client_config().unwrap())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let body = r#"{"dataInizioPubProvvedimento":"1982-03-01T00:00:00.000Z","dataFinePubProvvedimento":"1982-04-01T00:00:00.000Z","paginazione":{"paginaCorrente":0,"numeroElementiPerPagina":1}}"#;
        let res = client
            .post("https://api.normattiva.it/t/normattiva.api/bff-opendata/v1/api/v1/ricerca/avanzata")
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{}", res.status());
    }
}
