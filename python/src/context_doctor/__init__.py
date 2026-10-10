"""context-doctor for Python: budgeted context packing and token estimates, no dependencies.

    from context_doctor import pack_context, pack_documents, estimate_tokens
    packed = pack_documents(retrieved_docs, "how do I rotate the signing key", budget=4000)
    prompt_context = packed.render()

Same chunking, ranking and output as the npm package (`npx context-doctor pack`).
"""

from .integrations import pack_documents
from .pack import Chunk, PackResult, PackSource, chunk_source, pack_context, render_pack, score_chunks, terms
from .profile import Finding, Profile, profile_messages
from .tokens import estimate_tokens, format_tokens, provider_for

__version__ = "0.1.0"

__all__ = [
    "Chunk", "Finding", "PackResult", "PackSource", "Profile", "chunk_source", "estimate_tokens", "format_tokens",
    "pack_context", "pack_documents", "profile_messages", "provider_for", "render_pack", "score_chunks", "terms",
]
