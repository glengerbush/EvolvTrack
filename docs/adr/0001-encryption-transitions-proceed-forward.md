# Encryption Transitions proceed forward

An Encryption Transition may be abandoned before remote mutation begins, but is not cancellable afterward. Once remote mutation starts, EvolvTrack proceeds through resume, takeover, or recovery because rollback would introduce a second destructive conversion path and increase the risk of data loss or mixed encryption state.
