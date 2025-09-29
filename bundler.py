import os
import re
import tarfile
import tempfile
import urllib.request
from urllib.error import URLError


def fetch_file_from_tgz(tgz_url, file_in_tgz, output_path):
    """
    Download a tgz archive from a URL, extract the specified file, and save it to output_path.

    Args:
        tgz_url (str): URL of the .tgz archive.
        file_in_tgz (str): Relative path of the file inside the archive.
        output_path (str): Destination path to save the extracted file.

    Returns:
        bool: True if successful.

    Raises:
        RuntimeError: If download fails or archive is invalid.
        FileNotFoundError: If the specified file is not found inside the tgz.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temp_tgz_path = None

    try:
        # Download tgz to a temporary file
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_tgz_path = temp_file.name
        try:
            with urllib.request.urlopen(tgz_url) as resp, open(temp_tgz_path, 'wb') as out_file:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    out_file.write(chunk)
        except URLError as e:
            raise RuntimeError(f"Failed to download tgz: {e.reason}")

        # Open tgz and extract target file
        with tarfile.open(temp_tgz_path, "r:gz") as tgz:
            names = tgz.getnames()
            if file_in_tgz not in names:
                sample_files = ', '.join(names[:5])
                raise FileNotFoundError(
                    f"File '{file_in_tgz}' not found in tgz.\n"
                    f"Sample available files: {sample_files} ..."
                )
            member = tgz.getmember(file_in_tgz)
            with tgz.extractfile(member) as src, open(output_path, "wb") as dest:
                dest.write(src.read())
        return True

    except tarfile.ReadError:
        raise RuntimeError("Failed to open tgz: not a valid .tar.gz file")
    finally:
        # Clean up temporary file
        if temp_tgz_path and os.path.exists(temp_tgz_path):
            try:
                os.unlink(temp_tgz_path)
            except OSError:
                pass


def strip_require_meta(js_source):
    """
    Remove all '// @require ...' lines from a JavaScript source string.

    Args:
        js_source (str): The original JavaScript code.

    Returns:
        str: Source code without '// @require' lines.
    """
    return re.sub(
        pattern=r"^[ \t]*//[ \t]*@require[ \t]+[^\r\n]+$",
        repl='',
        string=js_source,
        flags=re.MULTILINE
    )


def embed_js_lib_inline(source, require_tag, lib_path):
    """
    Insert the content of a JavaScript library below the specified placeholder marker in the user script.

    Args:
        source (str): The user script source.
        require_tag (str): The marker line for inserting the library code.
        lib_path (str): Path to the JavaScript library file.

    Returns:
        str: The updated source code with the library embedded.
    """
    with open(lib_path, 'r', encoding='utf-8') as f:
        lib_code = f.read()
    return source.replace(require_tag, f"{require_tag}\n{lib_code}")


if __name__ == "__main__":
    # Load original user script and remove @require comments
    with open("github-dashboard-feed.js", 'r', encoding='utf-8') as f:
        source = f.read()
    source = strip_require_meta(source)

    # Download and extract markdown-it library
    fetch_file_from_tgz(
        tgz_url="https://registry.npmjs.org/markdown-it/-/markdown-it-14.1.0.tgz",
        file_in_tgz="package/dist/markdown-it.min.js",
        output_path="dist/markdown-it.min.js"
    )
    # Inject markdown-it code into the user script
    source = embed_js_lib_inline(
        source=source,
        require_tag="// ================== REQUIRES ==================",
        lib_path="dist/markdown-it.min.js"
    )

    # Download and extract DOMPurify library
    fetch_file_from_tgz(
        tgz_url="https://registry.npmjs.org/dompurify/-/dompurify-3.2.7.tgz",
        file_in_tgz="package/dist/purify.min.js",
        output_path="dist/purify.min.js"
    )
    # Inject DOMPurify code into the user script
    source = embed_js_lib_inline(
        source=source,
        require_tag="// ================== REQUIRES ==================",
        lib_path="dist/purify.min.js"
    )

    # Write the final result to a new JS file
    with open("github-dashboard-feed.userscript.js", "w", encoding='utf-8') as f:
        f.write(source)
