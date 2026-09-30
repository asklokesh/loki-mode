import importlib
import re


def _provider(locale):
    # Lazy import so the module not existing at the base commit fails each
    # test instead of the whole file at collection (see NOTES.md, trim).
    return importlib.import_module(f"faker.providers.lorem.{locale}").Provider


class TestEsEs:
    """Test es_ES lorem provider"""

    @property
    def word_list(self):
        return [word.lower() for word in _provider("es_ES").word_list]

    def test_paragraph(self, faker, num_samples):
        num_sentences = 10
        for _ in range(num_samples):
            paragraph = faker.paragraph(nb_sentences=num_sentences)
            assert isinstance(paragraph, str)
            words = paragraph.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_paragraphs(self, faker, num_samples):
        num_paragraphs = 5
        for _ in range(num_samples):
            paragraphs = faker.paragraphs(nb=num_paragraphs)
            for paragraph in paragraphs:
                assert isinstance(paragraph, str)
                words = paragraph.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_sentence(self, faker, num_samples):
        num_words = 10
        for _ in range(num_samples):
            sentence = faker.sentence(nb_words=num_words)
            assert isinstance(sentence, str)
            words = sentence.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_sentences(self, faker, num_samples):
        num_sentences = 5
        for _ in range(num_samples):
            sentences = faker.sentences(nb=num_sentences)
            for sentence in sentences:
                assert isinstance(sentence, str)
                words = sentence.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_text(self, faker, num_samples):
        num_chars = 25
        for _ in range(num_samples):
            text = faker.text(max_nb_chars=num_chars)
            assert isinstance(text, str)
            words = re.sub(r"[.\n]+", " ", text).split()
            assert all(word.lower() in self.word_list for word in words)

    def test_texts(self, faker, num_samples):
        num_texts = 5
        num_chars = 25
        for _ in range(num_samples):
            texts = faker.texts(max_nb_chars=num_chars, nb_texts=num_texts)
            for text in texts:
                assert isinstance(text, str)
                words = re.sub(r"[.\n]+", " ", text).split()
                assert all(word.lower() in self.word_list for word in words)

    def test_word(self, faker, num_samples):
        for _ in range(num_samples):
            word = faker.word()
            assert isinstance(word, str) and word in _provider("es_ES").word_list

    def test_words(self, faker, num_samples):
        num_words = 5
        for _ in range(num_samples):
            words = faker.words(num_words)
            assert all(isinstance(word, str) and word in _provider("es_ES").word_list for word in words)


class TestEsAr:
    """Test es_AR lorem provider"""

    @property
    def word_list(self):
        return [word.lower() for word in _provider("es_AR").word_list]

    def test_paragraph(self, faker, num_samples):
        num_sentences = 10
        for _ in range(num_samples):
            paragraph = faker.paragraph(nb_sentences=num_sentences)
            assert isinstance(paragraph, str)
            words = paragraph.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_paragraphs(self, faker, num_samples):
        num_paragraphs = 5
        for _ in range(num_samples):
            paragraphs = faker.paragraphs(nb=num_paragraphs)
            for paragraph in paragraphs:
                assert isinstance(paragraph, str)
                words = paragraph.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_sentence(self, faker, num_samples):
        num_words = 10
        for _ in range(num_samples):
            sentence = faker.sentence(nb_words=num_words)
            assert isinstance(sentence, str)
            words = sentence.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_sentences(self, faker, num_samples):
        num_sentences = 5
        for _ in range(num_samples):
            sentences = faker.sentences(nb=num_sentences)
            for sentence in sentences:
                assert isinstance(sentence, str)
                words = sentence.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_text(self, faker, num_samples):
        num_chars = 25
        for _ in range(num_samples):
            text = faker.text(max_nb_chars=num_chars)
            assert isinstance(text, str)
            words = re.sub(r"[.\n]+", " ", text).split()
            assert all(word.lower() in self.word_list for word in words)

    def test_texts(self, faker, num_samples):
        num_texts = 5
        num_chars = 25
        for _ in range(num_samples):
            texts = faker.texts(max_nb_chars=num_chars, nb_texts=num_texts)
            for text in texts:
                assert isinstance(text, str)
                words = re.sub(r"[.\n]+", " ", text).split()
                assert all(word.lower() in self.word_list for word in words)

    def test_word(self, faker, num_samples):
        for _ in range(num_samples):
            word = faker.word()
            assert isinstance(word, str) and word in _provider("es_ES").word_list

    def test_words(self, faker, num_samples):
        num_words = 5
        for _ in range(num_samples):
            words = faker.words(num_words)
            assert all(isinstance(word, str) and word in _provider("es_ES").word_list for word in words)


class TestEsMx:
    """Test es_MX lorem provider"""

    @property
    def word_list(self):
        return [word.lower() for word in _provider("es_MX").word_list]

    def test_paragraph(self, faker, num_samples):
        num_sentences = 10
        for _ in range(num_samples):
            paragraph = faker.paragraph(nb_sentences=num_sentences)
            assert isinstance(paragraph, str)
            words = paragraph.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_paragraphs(self, faker, num_samples):
        num_paragraphs = 5
        for _ in range(num_samples):
            paragraphs = faker.paragraphs(nb=num_paragraphs)
            for paragraph in paragraphs:
                assert isinstance(paragraph, str)
                words = paragraph.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_sentence(self, faker, num_samples):
        num_words = 10
        for _ in range(num_samples):
            sentence = faker.sentence(nb_words=num_words)
            assert isinstance(sentence, str)
            words = sentence.replace(".", "").split()
            assert all(word.lower() in self.word_list for word in words)

    def test_sentences(self, faker, num_samples):
        num_sentences = 5
        for _ in range(num_samples):
            sentences = faker.sentences(nb=num_sentences)
            for sentence in sentences:
                assert isinstance(sentence, str)
                words = sentence.replace(".", "").split()
                assert all(word.lower() in self.word_list for word in words)

    def test_text(self, faker, num_samples):
        num_chars = 25
        for _ in range(num_samples):
            text = faker.text(max_nb_chars=num_chars)
            assert isinstance(text, str)
            words = re.sub(r"[.\n]+", " ", text).split()
            assert all(word.lower() in self.word_list for word in words)

    def test_texts(self, faker, num_samples):
        num_texts = 5
        num_chars = 25
        for _ in range(num_samples):
            texts = faker.texts(max_nb_chars=num_chars, nb_texts=num_texts)
            for text in texts:
                assert isinstance(text, str)
                words = re.sub(r"[.\n]+", " ", text).split()
                assert all(word.lower() in self.word_list for word in words)

    def test_word(self, faker, num_samples):
        for _ in range(num_samples):
            word = faker.word()
            assert isinstance(word, str) and word in _provider("es_ES").word_list

    def test_words(self, faker, num_samples):
        num_words = 5
        for _ in range(num_samples):
            words = faker.words(num_words)
            assert all(isinstance(word, str) and word in _provider("es_ES").word_list for word in words)
