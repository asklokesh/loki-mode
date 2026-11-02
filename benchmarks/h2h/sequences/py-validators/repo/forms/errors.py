class ValidationError(ValueError):
    """A field failed validation. str(err) is "<field>: <message>"."""

    def __init__(self, field, message):
        super().__init__(f"{field}: {message}")
        self.field = field
        self.message = message
