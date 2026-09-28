package com.example;

import com.example.util.*;
import static com.example.other.Formatter.format;
import static com.example.missing.Ghost.boo;

public class Main {
    public static void main(String[] args) {
        Helper.greet();
        Standalone.value();
        format("x");
        boo();
    }
}
