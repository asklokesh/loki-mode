from setuptools import setup, find_packages

setup(
    name="legacy-checkout-app",
    version="1.0.0",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    python_requires=">=3.8",
    install_requires=[
        "flask>=3.0.0",
        "stripe>=7.0.0",
    ],
)
